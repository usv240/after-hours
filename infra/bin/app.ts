import { App } from "aws-cdk-lib";
import { AfterHoursStack } from "../lib/stack.ts";

const app = new App();
new AfterHoursStack(app, "AfterHours", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
  description: "After Hours: time-aware defibrillator map (AWS Weekend Challenge: Map it)",
});
