# RDS Database Auto Start Preventer (AWS CDK v2)

[![GitHub](https://img.shields.io/github/license/gammarers-aws-cdk-constructs/aws-rds-database-auto-start-preventer?style=flat-square)](https://github.com/gammarers-aws-cdk-constructs/aws-rds-database-auto-start-preventer/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/aws-rds-database-auto-start-preventer?style=flat-square)](https://www.npmjs.com/package/aws-rds-database-auto-start-preventer)
[![GitHub Workflow Status (branch)](https://img.shields.io/github/actions/workflow/status/gammarers-aws-cdk-constructs/aws-rds-database-auto-start-preventer/release.yml?branch=main&label=release&style=flat-square)](https://github.com/gammarers-aws-cdk-constructs/aws-rds-database-auto-start-preventer/actions/workflows/release.yml)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gammarers-aws-cdk-constructs/aws-rds-database-auto-start-preventer?sort=semver&style=flat-square)](https://github.com/gammarers-aws-cdk-constructs/aws-rds-database-auto-start-preventer/releases)

[![View on Construct Hub](https://constructs.dev/badge?package=aws-rds-database-auto-start-preventer)](https://constructs.dev/packages/aws-rds-database-auto-start-preventer)

CDK stack that stops RDS DB instances and clusters after they are auto-started by AWS (RDS-EVENT-0154 / RDS-EVENT-0153). It uses EventBridge rules and a Durable Lambda to detect auto-start events, optionally filter by tags, stop the resource if it matches, and post a notification to Slack.

## Features

- **EventBridge integration** – Listens for RDS DB Instance (RDS-EVENT-0154) and DB Cluster (RDS-EVENT-0153) auto-start events
- **Tag-based targeting** – Only stops instances/clusters that match a given tag key and tag values
- **Durable Lambda** – Uses AWS Lambda Durable Execution for reliable, long-running workflow (polling RDS until stopped)
- **Slack notifications** – Sends a message to a Slack channel when an auto-started resource is stopped (via token and channel from AWS Secrets Manager)
- **Optional rule toggle** – EventBridge rules can be enabled or disabled via `enableRule`

## Installation

**npm**

```bash
npm install aws-rds-database-auto-start-preventer
```

**yarn**

```bash
yarn add aws-rds-database-auto-start-preventer
```

## Usage

Use the `RDSDatabaseAutoStartPreventer` construct when you want to add auto-start prevention to an existing stack or compose it with other constructs.

```typescript
import { Stack } from 'aws-cdk-lib';
import { RDSDatabaseAutoStartPreventer } from 'aws-rds-database-auto-start-preventer';

const stack = new Stack(app, 'MyStack');

new RDSDatabaseAutoStartPreventer(stack, 'RDSDatabaseAutoStartPreventer', {
  targetResource: {
    tagKey: 'AutoStartPrevent',
    tagValues: ['YES'],
  },
  enableRule: true, // optional, defaults to true
  secrets: {
    slackSecretName: 'my-app/slack',
  },
});
```

Use the `RDSDatabaseAutoStartPreventStack` when you want a dedicated stack that only deploys the RDS auto-start prevent resources.

```typescript
import { RDSDatabaseAutoStartPreventStack } from 'aws-rds-database-auto-start-preventer';

new RDSDatabaseAutoStartPreventStack(app, 'RDSDatabaseAutoStartPreventStack', {
  stackName: 'rds-database-auto-start-prevent',
  targetResource: {
    tagKey: 'AutoStartPrevent',
    tagValues: ['YES'],
  },
  enableRule: true, // optional, defaults to true
  secrets: {
    slackSecretName: 'my-app/slack',
  },
});
```

### Slack secret (AWS Secrets Manager)

Store a JSON object in AWS Secrets Manager with the Slack Bot Token and channel ID:

| Key     | Value            |
|---------|------------------|
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
| `targetResource` | `TargetResource` | Yes | Tag-based criteria for which RDS instances/clusters to protect. |
| `targetResource.tagKey` | `string` | Yes | Tag key to match (e.g. `AutoStartPrevent`, `Environment`). |
| `targetResource.tagValues` | `string[]` | Yes | Tag values that indicate the resource should be protected (e.g. `['YES']`, `['production']`). |
| `enableRule` | `boolean` | No | Whether the EventBridge rules are enabled. Defaults to `true` if omitted. |
| `secrets` | `Secrets` | Yes | External secrets for notifications. |
| `secrets.slackSecretName` | `string` | Yes | Name of the Secrets Manager secret containing Slack `token` and `channel`. |

## Requirements

- **Node.js** >= 20.0.0 (for CDK app)
- **AWS CDK** ^2.232.0
- **constructs** ^10.5.1
- **AWS Lambda** runtime Node.js 22+ (used by the Durable Lambda; managed by the construct)

## License

This project is licensed under the Apache-2.0 License.
