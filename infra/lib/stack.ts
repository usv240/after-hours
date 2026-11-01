import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as athena from "aws-cdk-lib/aws-athena";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as glue from "aws-cdk-lib/aws-glue";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as location from "aws-cdk-lib/aws-location";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOURS_MODEL = "anthropic.claude-haiku-4-5-20251001-v1:0";

export class AfterHoursStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- storage ----------
    const site = new s3.Bucket(this, "Site", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const lake = new s3.Bucket(this, "Lake", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ prefix: "athena-results/", expiration: Duration.days(7) }],
    });
    const table = new dynamodb.Table(this, "Counters", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------- API ----------
    const bundling: nodejs.BundlingOptions = { minify: true, target: "node22", sourceMap: false, format: nodejs.OutputFormat.CJS };
    const apiFn = new nodejs.NodejsFunction(this, "Api", {
      entry: resolve(ROOT, "api/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1536,
      timeout: Duration.seconds(29),
      bundling,
      depsLockFilePath: resolve(ROOT, "package-lock.json"),
      projectRoot: ROOT,
      logRetention: logs.RetentionDays.TWO_WEEKS,
      environment: { DATA_BUCKET: site.bucketName, TABLE: table.tableName, KEYS_PER_DAY: "300", DEBATES_PER_DAY: "400" },
    });
    site.grantRead(apiFn, "data/*");
    table.grant(apiFn, "dynamodb:UpdateItem");
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["geo-routes:CalculateRouteMatrix", "geo-routes:CalculateRoutes", "geo-routes:CalculateIsolines", "geo-places:Geocode", "geo-places:SearchText"],
        resources: [`arn:aws:geo-routes:${this.region}::provider/default`, `arn:aws:geo-places:${this.region}::provider/default`],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [`arn:aws:bedrock:*::foundation-model/${HOURS_MODEL}`, `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.${HOURS_MODEL}`],
      }),
    );

    const api = new apigw.RestApi(this, "PublicApi", {
      restApiName: "after-hours",
      description: "After Hours public API",
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit: 30,
        throttlingBurstLimit: 60,
      },
      defaultCorsPreflightOptions: { allowOrigins: apigw.Cors.ALL_ORIGINS, allowHeaders: ["content-type", "x-api-key"], allowMethods: ["GET", "POST", "OPTIONS"] },
      apiKeySourceType: apigw.ApiKeySourceType.HEADER,
    });
    const integration = new apigw.LambdaIntegration(apiFn, { proxy: true });
    const root = api.root.addResource("api");
    root.addResource("site").addProxy({ defaultIntegration: integration, anyMethod: true });
    root.addResource("mcp").addMethod("ANY", integration);
    const v1 = root.addResource("v1").addResource("{proxy+}");
    v1.addMethod("GET", integration, { apiKeyRequired: true });
    v1.addMethod("POST", integration, { apiKeyRequired: true });

    const plan = api.addUsagePlan("Developers", {
      name: "after-hours-developers",
      description: "Self-serve keys from after-hours site",
      throttle: { rateLimit: 5, burstLimit: 10 },
      quota: { limit: 1000, period: apigw.Period.DAY },
      apiStages: [{ api, stage: api.deploymentStage }],
    });
    // The Lambda finds the plan by name at run time; referencing its id here would make a dependency cycle.
    apiFn.addEnvironment("USAGE_PLAN_NAME", "after-hours-developers");
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["apigateway:POST", "apigateway:GET"],
        resources: [`arn:aws:apigateway:${this.region}::/apikeys`, `arn:aws:apigateway:${this.region}::/usageplans`, `arn:aws:apigateway:${this.region}::/usageplans/*/keys`, `arn:aws:apigateway:${this.region}::/tags/*`],
      }),
    );

    // ---------- CDN ----------
    const dist = new cloudfront.Distribution(this, "Cdn", {
      comment: "After Hours",
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(`${api.restApiId}.execute-api.${this.region}.amazonaws.com`, { originPath: "/prod" }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      errorResponses: [{ httpStatus: 404, responseHttpStatus: 404, responsePagePath: "/index.html", ttl: Duration.minutes(5) }],
    });

    // ---------- Amazon Location map key (browser) ----------
    const mapKey = new location.CfnAPIKey(this, "MapKey", {
      keyName: "after-hours-maps",
      description: "Basemap tiles for the After Hours site",
      noExpiry: true,
      restrictions: {
        allowActions: ["geo-maps:GetTile", "geo-maps:GetStaticMap"],
        allowResources: [`arn:aws:geo-maps:${this.region}::provider/default`],
        allowReferers: [`https://${dist.distributionDomainName}/*`, "http://localhost:5173/*", "http://localhost:4173/*"],
      },
    });

    // ---------- Iceberg on S3, Athena, nightly refresh ----------
    const db = new glue.CfnDatabase(this, "Db", { catalogId: this.account, databaseInput: { name: "after_hours", description: "After Hours AED registry snapshots" } });
    const cols = [
      { name: "site_id", type: "string" },
      { name: "name", type: "string" },
      { name: "category", type: "string" },
      { name: "borough", type: "string" },
      { name: "zip", type: "string" },
      { name: "latitude", type: "double" },
      { name: "longitude", type: "double" },
      { name: "aeds", type: "int" },
    ];
    const staging = new glue.CfnTable(this, "Staging", {
      catalogId: this.account,
      databaseName: "after_hours",
      tableInput: {
        name: "aed_staging",
        tableType: "EXTERNAL_TABLE",
        partitionKeys: [{ name: "snapshot_date", type: "string" }],
        parameters: {
          "projection.enabled": "true",
          "projection.snapshot_date.type": "date",
          "projection.snapshot_date.format": "yyyy-MM-dd",
          "projection.snapshot_date.range": "2026-10-01,NOW",
          "storage.location.template": `s3://${lake.bucketName}/staging/aed/snapshot_date=\${snapshot_date}/`,
          classification: "json",
        },
        storageDescriptor: {
          columns: cols,
          location: `s3://${lake.bucketName}/staging/aed/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
        },
      },
    });
    staging.addDependency(db);
    const iceberg = new glue.CfnTable(this, "Snapshots", {
      catalogId: this.account,
      databaseName: "after_hours",
      openTableFormatInput: { icebergInput: { metadataOperation: "CREATE", version: "2" } },
      tableInput: {
        name: "aed_snapshots",
        tableType: "EXTERNAL_TABLE",
        storageDescriptor: {
          columns: [...cols, { name: "snapshot_date", type: "date" }],
          location: `s3://${lake.bucketName}/iceberg/aed_snapshots/`,
        },
      },
    });
    iceberg.addDependency(db);
    const wg = new athena.CfnWorkGroup(this, "Workgroup", {
      name: "after-hours",
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        resultConfiguration: { outputLocation: `s3://${lake.bucketName}/athena-results/` },
        engineVersion: { selectedEngineVersion: "Athena engine version 3" },
        enforceWorkGroupConfiguration: true,
        bytesScannedCutoffPerQuery: 10 * 1024 ** 3,
      },
    });

    const refreshFn = new nodejs.NodejsFunction(this, "Refresh", {
      entry: resolve(ROOT, "api/src/refresh.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(5),
      bundling,
      depsLockFilePath: resolve(ROOT, "package-lock.json"),
      projectRoot: ROOT,
      logRetention: logs.RetentionDays.TWO_WEEKS,
      environment: { LAKE_BUCKET: lake.bucketName, SITE_BUCKET: site.bucketName, WORKGROUP: wg.name, DATABASE: "after_hours", DISTRIBUTION_ID: dist.distributionId },
    });
    lake.grantReadWrite(refreshFn);
    site.grantPut(refreshFn, "data/nyc/changes.json");
    refreshFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults"],
        resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${wg.name}`],
      }),
    );
    refreshFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["glue:GetDatabase", "glue:GetTable", "glue:GetTables", "glue:UpdateTable", "glue:GetPartition", "glue:GetPartitions", "glue:BatchGetPartition"],
        resources: [`arn:aws:glue:${this.region}:${this.account}:catalog`, `arn:aws:glue:${this.region}:${this.account}:database/after_hours`, `arn:aws:glue:${this.region}:${this.account}:table/after_hours/*`],
      }),
    );
    refreshFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["cloudfront:CreateInvalidation"], resources: [`arn:aws:cloudfront::${this.account}:distribution/${dist.distributionId}`] }),
    );

    const schedRole = new iam.Role(this, "SchedulerRole", { assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com") });
    refreshFn.grantInvoke(schedRole);
    new scheduler.CfnSchedule(this, "Nightly", {
      name: "after-hours-nightly-refresh",
      description: "Snapshot the NYC AED registry into Iceberg and publish what changed",
      scheduleExpression: "cron(15 6 * * ? *)",
      scheduleExpressionTimezone: "America/New_York",
      flexibleTimeWindow: { mode: "OFF" },
      target: { arn: refreshFn.functionArn, roleArn: schedRole.roleArn, retryPolicy: { maximumRetryAttempts: 2 } },
    });

    new CfnOutput(this, "SiteUrl", { value: `https://${dist.distributionDomainName}` });
    new CfnOutput(this, "DistributionId", { value: dist.distributionId });
    new CfnOutput(this, "SiteBucket", { value: site.bucketName });
    new CfnOutput(this, "LakeBucket", { value: lake.bucketName });
    new CfnOutput(this, "MapKeyName", { value: mapKey.keyName });
    new CfnOutput(this, "RefreshFunction", { value: refreshFn.functionName });
    new CfnOutput(this, "UsagePlanId", { value: plan.usagePlanId });
  }
}
