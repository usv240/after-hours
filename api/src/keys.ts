import { APIGatewayClient, CreateApiKeyCommand, CreateUsagePlanKeyCommand, GetUsagePlansCommand } from "@aws-sdk/client-api-gateway";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const apigw = new APIGatewayClient({});
const ddb = new DynamoDBClient({});
const DAILY_CAP = Number(process.env.KEYS_PER_DAY ?? 300);

let planId: Promise<string | undefined> | null = null;
function usagePlanId() {
  const name = process.env.USAGE_PLAN_NAME;
  if (!name) return Promise.resolve(undefined);
  planId ??= apigw.send(new GetUsagePlansCommand({ limit: 100 })).then((r) => r.items?.find((p) => p.name === name)?.id);
  return planId;
}

/**
 * Mints a developer key on the API Gateway usage plan (5 requests/s, 1,000/day).
 * A DynamoDB counter caps keys per day so the public button cannot be farmed.
 */
export async function mintKey(label: string): Promise<{ key: string; id: string; plan: string }> {
  const plan = await usagePlanId();
  if (!plan) throw Object.assign(new Error("Key minting is only available on the deployed API."), { status: 503 });
  await spend("keys", DAILY_CAP, "Today's key limit is reached. Try again tomorrow.");
  const day = new Date().toISOString().slice(0, 10);
  const clean = label.replace(/[^\w .-]/g, "").slice(0, 40) || "developer";
  const created = await apigw.send(
    new CreateApiKeyCommand({ name: `ah-${day}-${clean}-${Math.random().toString(36).slice(2, 8)}`, enabled: true, description: "After Hours self-serve key" }),
  );
  await apigw.send(new CreateUsagePlanKeyCommand({ usagePlanId: plan, keyId: created.id!, keyType: "API_KEY" }));
  return { key: created.value!, id: created.id!, plan: "5 requests per second, 1,000 per day" };
}

/** Counts a daily action in DynamoDB and refuses once the day's cap is reached. */
export async function spend(kind: string, cap: number, message: string) {
  if (!process.env.TABLE) return;
  const day = new Date().toISOString().slice(0, 10);
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: process.env.TABLE,
        Key: { pk: { S: `${kind}#${day}` } },
        UpdateExpression: "ADD n :one SET expiresAt = if_not_exists(expiresAt, :exp)",
        ConditionExpression: "attribute_not_exists(n) OR n < :cap",
        ExpressionAttributeValues: { ":one": { N: "1" }, ":cap": { N: String(cap) }, ":exp": { N: String(Math.floor(Date.now() / 1000) + 3 * 86400) } },
      }),
    );
  } catch (e) {
    if ((e as Error).name === "ConditionalCheckFailedException") throw Object.assign(new Error(message), { status: 429 });
    throw e;
  }
}
