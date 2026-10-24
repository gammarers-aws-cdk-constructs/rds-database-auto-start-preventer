# RDS Database Auto Start Preventer (CDK v2)

[![npm version](https://img.shields.io/npm/v/rds-database-auto-start-preventer?style=flat-square)](https://www.npmjs.com/package/rds-database-auto-start-preventer)
[![license](https://img.shields.io/npm/l/rds-database-auto-start-preventer?style=flat-square)](https://www.npmjs.com/package/rds-database-auto-start-preventer)
[![Node.js](https://img.shields.io/node/v/rds-database-auto-start-preventer?style=flat-square)](https://www.npmjs.com/package/rds-database-auto-start-preventer)
[![build](https://img.shields.io/github/actions/workflow/status/gammarers-aws-cdk-constructs/rds-database-auto-start-preventer/build.yml?label=build&style=flat-square)](https://github.com/gammarers-aws-cdk-constructs/rds-database-auto-start-preventer/actions/workflows/build.yml)

[![View on Construct Hub](https://constructs.dev/badge?package=rds-database-auto-start-preventer)](https://constructs.dev/packages/rds-database-auto-start-preventer)

CDK construct library that stops RDS DB instances and clusters after they are auto-started by AWS (RDS-EVENT-0154 / RDS-EVENT-0153). It uses EventBridge rules and a Durable Lambda to detect auto-start events, filter resources by tags in the handler, stop matching resources when they are `available`, and post a Slack notification only when this Lambda invoked the stop API successfully and a Slack secret name is set.

## Features

- **EventBridge integration** – Listens for RDS DB Instance (RDS-EVENT-0154) and DB Cluster (RDS-EVENT-0153) auto-start events
- **Handler-side tag filtering** – EventBridge rules match all auto-start events; the Lambda evaluates `TagList` from `rds:DescribeDBInstances` / `rds:DescribeDBClusters` and skips resources that do not match `tagKey` / `tagValues`
- **Durable Lambda** – Uses AWS Lambda Durable Execution for reliable, long-running workflow (initial wait, status wait, stop, and post-stop wait)
- **Least-privilege IAM** – Describe is scoped to account/region `db` / `cluster` ARNs; Stop is further limited by `aws:ResourceTag` matching `tagKey` / `tagValues` (no Resource Groups Tagging API)
- **Slack notifications** – When `slackSecretName` is set, sends a message when this invocation called `StopDBInstance` / `StopDBCluster` and the resource reached `stopped` (no notification when the secret name is omitted, the resource was already stopped, or tags did not match)
- **Optional rule toggle** – EventBridge rules can be enabled or disabled via `enableRule`

## How it works

1. EventBridge invokes the Durable Lambda with the RDS auto-start event and tag filter parameters (`tagKey`, `tagValues`).
2. The handler waits 1 minute, then waits on DescribeDB* until the resource leaves transitional statuses.
3. If the resource tag does not match, the handler exits with no stop action.
4. If the resource is `available` and tags match, the handler calls StopDB* and waits until `stopped`.
5. If the resource is already `stopped` (for example, stopped by another process), the handler exits without calling StopDB* and without posting to Slack.
6. When `slackSecretName` is set, Slack is notified only when StopDB* was invoked by this invocation and the resource reached `stopped`. When it is omitted, the handler does not post to Slack.

Tag the RDS instances or clusters you want to protect (for example, `AutoStartPrevent=YES`). Resources without a matching tag are left running.

## Installation

### npm

```bash
npm install rds-database-auto-start-preventer
```

### yarn

```bash
yarn add rds-database-auto-start-preventer
```

### pnpm

```bash
pnpm add rds-database-auto-start-preventer
```

## Usage

### Minimal deployable app

Use `RDSDatabaseAutoStartPreventStack` when you want a dedicated stack you can deploy as-is. Put this in your CDK app entry (for example `bin/app.ts`), then deploy.

```typescript
import { App } from 'aws-cdk-lib';
import { RDSDatabaseAutoStartPreventStack } from 'rds-database-auto-start-preventer';

const app = new App();

new RDSDatabaseAutoStartPreventStack(app, 'RDSDatabaseAutoStartPreventStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  stackName: 'rds-database-auto-start-prevent',
  targetResource: {
    tagKey: 'AutoStartPrevent',
    tagValues: ['YES'],
  },
  // Omit slackSecretName to skip Slack; set it when stop should notify Slack.
  secrets: {
    slackSecretName: 'my-app/slack',
  },
});

app.synth();
```

Deploy checklist:

1. Install this package and peers (`aws-cdk-lib`, `constructs`) in your CDK app.
2. Tag the RDS instances or clusters to protect (for example `AutoStartPrevent=YES`).
3. Optional: create the Secrets Manager secret described in [Slack secret](#slack-secret-aws-secrets-manager). Omit `slackSecretName` if you do not need Slack.
4. From the CDK app: `npx cdk deploy RDSDatabaseAutoStartPreventStack`

### Construct in an existing stack

Use `RDSDatabaseAutoStartPreventer` when you want to add auto-start prevention to an existing stack or compose it with other constructs. Omit `slackSecretName` to stop matching resources without Slack.

```typescript
import { App, Stack } from 'aws-cdk-lib';
import { RDSDatabaseAutoStartPreventer } from 'rds-database-auto-start-preventer';

const app = new App();
const stack = new Stack(app, 'MyStack');

new RDSDatabaseAutoStartPreventer(stack, 'RDSDatabaseAutoStartPreventer', {
  targetResource: {
    tagKey: 'AutoStartPrevent',
    tagValues: ['YES'],
  },
  secrets: {},
});
```

Pass `slackSecretName` when a successful stop should post to Slack. `enableRule` defaults to `true`.

```typescript
new RDSDatabaseAutoStartPreventer(stack, 'RDSDatabaseAutoStartPreventer', {
  targetResource: {
    tagKey: 'AutoStartPrevent',
    tagValues: ['YES'],
  },
  enableRule: true,
  secrets: {
    slackSecretName: 'my-app/slack',
  },
});
```

### Slack secret (AWS Secrets Manager)

Store a JSON object in AWS Secrets Manager with the Slack Bot Token and channel ID:

| Key | Value |
|-----|-------|
| `token` | Slack Bot Token (e.g. `xoxb-...`) |
| `channel` | Slack channel ID (e.g. `C01234ABCD`) |

Example secret value:

```json
{
  "token": "xoxb-...",
  "channel": "C01234ABCD"
}
```

## Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `targetResource` | `TargetResource` | Yes | Tag-based criteria evaluated in the Lambda handler. |
| `targetResource.tagKey` | `string` | Yes | Tag key to match (e.g. `AutoStartPrevent`, `Environment`). |
| `targetResource.tagValues` | `string[]` | Yes | Tag values that indicate the resource should be stopped (e.g. `['YES']`, `['production']`). |
| `enableRule` | `boolean` | No | Whether the EventBridge rules are enabled. Defaults to `true` if omitted. |
| `secrets` | `Secrets` | Yes | External secrets for notifications. |
| `secrets.slackSecretName` | `string` | No | Name of the Secrets Manager secret containing Slack `token` and `channel`. Omit it to skip Slack notifications. |

Empty `tagKey`, an empty `tagValues` array (or blank entries), and a blank `slackSecretName` fail at synthesis. Omitting `slackSecretName` is allowed. Unresolved CDK tokens are not checked.

## API

See [API.md](./API.md).

## Requirements

- **Node.js** >= 20.0.0 (for your CDK app)
- **AWS CDK** ^2.232.0
- **constructs** ^10.5.1
- **AWS Lambda** runtime Node.js 24.x with Durable Execution (deployed by the construct)

## License

This project is licensed under the Apache-2.0 License.
