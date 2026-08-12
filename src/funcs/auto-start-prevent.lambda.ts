import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import {
  RDSClient,
  DescribeDBInstancesCommand,
  DescribeDBClustersCommand,
  StopDBInstanceCommand,
  StopDBClusterCommand,
} from '@aws-sdk/client-rds';
import { WebClient } from '@slack/web-api';
import { secretFetcher } from 'aws-lambda-secret-fetcher';

/**
 * Detail payload of an RDS auto-start event from EventBridge.
 */
interface RdsAutoStartDetail {
  /** Event ID: RDS-EVENT-0154 (DB instance) or RDS-EVENT-0153 (DB cluster). */
  EventID: 'RDS-EVENT-0154' | 'RDS-EVENT-0153';
  /** Resource type that emitted the event. */
  SourceType: 'DB_INSTANCE' | 'CLUSTER';
  /** ARN of the DB instance or cluster. */
  SourceArn: string;
  /** DB instance or cluster identifier from the event. */
  SourceIdentifier: string;
}

/**
 * RDS auto-start event as received from EventBridge.
 */
interface RdsAutoStartEvent {
  'detail-type': 'RDS DB Instance Event' | 'RDS DB Cluster Event';
  'source': 'aws.rds';
  'detail': RdsAutoStartDetail;
}

/**
 * Tag-based filter parameters for the handler.
 */
interface AutoStartParams {
  /** Tag key to match on the resource. */
  tagKey: string;
  /** Allowed tag values; the resource is processed only when its tag value is in this list. */
  tagValues: string[];
}

/**
 * Slack credentials stored in Secrets Manager.
 */
interface SlackSecret {
  /** Slack bot or user OAuth token. */
  token: string;
  /** Channel ID or name to post notifications to. */
  channel: string;
}

/**
 * Type guard for Slack credentials returned by `secretFetcher.getSecretValue`.
 *
 * aws-lambda-secret-fetcher ^0.7 parses SecretString with quiet-json-parser and
 * falls back to the raw string on invalid JSON, so callers must validate shape.
 */
const isSlackSecret = (value: unknown): value is SlackSecret => {
  if (typeof value !== 'object' || value == null) {
    return false;
  }
  if (!('token' in value) || !('channel' in value)) {
    return false;
  }
  return typeof value.token === 'string' &&
    value.token.length > 0 &&
    typeof value.channel === 'string' &&
    value.channel.length > 0;
};

/**
 * Normalized handler input: EventBridge event and tag filter parameters.
 *
 * CDK always invokes the function with `{ event, params }` via EventBridge
 * `InputTransformer` (`RuleTargetInput.fromObject`). Direct Invoke must use
 * the same payload shape; tag filters are not read from environment variables.
 */
interface AutoStartPreventInput {
  event: RdsAutoStartEvent;
  params: AutoStartParams;
}

/**
 * Handler result when no stop action was taken.
 */
interface NoOpResult {
  action: 'no-op';
  reason: 'tag not matched or not found' | 'already stopped';
  status: string;
}

/**
 * Handler result when this invocation called StopDB* and the resource reached `stopped`.
 */
interface StoppedResult {
  action: 'stopped';
  finalStatus: string;
  account: string;
  region: string;
  identifier: string;
}

/**
 * Type guard: input is `{ event, params }` as produced by the EventBridge target.
 */
const isAutoStartPreventInput = (input: unknown): input is AutoStartPreventInput => {
  if (typeof input !== 'object' || input == null) {
    return false;
  }
  if (!('event' in input) || !('params' in input)) {
    return false;
  }
  return input.event != null && input.params != null;
};

/**
 * Normalizes invocation input to {@link AutoStartPreventInput}.
 *
 * @param input - `{ event, params }` from EventBridge InputTransformer (or the same shape on direct Invoke).
 * @returns Event plus tag filter parameters.
 * @throws When the payload is not `{ event, params }`.
 */
const normalizeInput = (input: unknown): AutoStartPreventInput => {
  if (isAutoStartPreventInput(input)) {
    return input;
  }
  throw new Error('Invalid input: expected { event, params }.');
};

/**
 * AWS-style tag (Key/Value).
 */
interface Tag {
  Key?: string;
  Value?: string;
}

/**
 * State snapshot while polling RDS describe APIs.
 */
interface PollState {
  /** Current DB instance or cluster status. */
  status: string;
  /** DB instance or cluster identifier. */
  identifier: string;
  /** Tags from the describe response; present on the first poll only. */
  tags?: Tag[];
}

/** Shared RDS client for describe and stop API calls. */
const rdsClient = new RDSClient({});

/**
 * RDS statuses that indicate an in-progress transition.
 * The handler polls every 5 minutes while the resource remains in one of these states.
 */
const TRANSITIONAL_STATUSES = new Set([
  'starting',
  'configuring-enhanced-monitoring',
  'backing-up',
  'modifying',
  'stopping',
]);

/**
 * Returns true if the resource has a tag with the given key and a value in the allowed list.
 *
 * @param params - Tag key and allowed values.
 * @param tags - Resource tag list (e.g. from DescribeDBInstances / DescribeDBClusters).
 * @returns Whether the tag matches.
 */
const matchTag = (params: AutoStartParams, tags?: Tag[]): boolean => {
  if (!tags || tags.length === 0) {
    return false;
  }
  const value = tags.find(t => t.Key === params.tagKey)?.Value;
  if (!value) {
    return false;
  }
  return params.tagValues.includes(value);
};

/**
 * Durable Lambda handler for RDS auto-start prevention.
 *
 * Workflow:
 * 1. Wait 1 minute, then poll DescribeDB* until the resource leaves transitional statuses.
 * 2. Read tags from the describe response `TagList`; skip when {@link matchTag} returns false.
 * 3. If status is `available`, call StopDB* and poll until `stopped`.
 * 4. If already `stopped` without calling StopDB*, return {@link NoOpResult} (no Slack notification).
 * 5. Post to Slack only when StopDB* was invoked and the resource reached `stopped`.
 *
 * Tag matching uses RDS Describe APIs only; Resource Groups Tagging API is not used.
 *
 * @param input - `{ event, params }` from EventBridge InputTransformer (same shape required for direct Invoke).
 * @param context - Durable execution context for steps and waits.
 * @returns {@link StoppedResult} or {@link NoOpResult}.
 * @throws When the payload is invalid, the event is unsupported, secrets are invalid, or stop did not reach `stopped`.
 */
export const handler = withDurableExecution(
  async (input: unknown, context: DurableContext): Promise<StoppedResult | NoOpResult> => {
    const { event, params } = normalizeInput(input);
    const { detail, 'detail-type': detailType } = event;

    const slackSecretName = process.env.SLACK_SECRET_NAME;
    if (!slackSecretName) {
      throw new Error('missing environment variable SLACK_SECRET_NAME.');
    }
    // Requires AWS Parameters and Secrets Extension (ParamsAndSecrets layer) and
    // AWS_SESSION_TOKEN from the Lambda runtime (aws-lambda-secret-fetcher ^0.6+).
    const slackSecretValue = await context.step('fetch-slack-secret', async () => {
      return secretFetcher.getSecretValue<SlackSecret>(slackSecretName);
    });

    if (!isSlackSecret(slackSecretValue)) {
      throw new Error('Slack secret must be JSON with non-empty token and channel.');
    }

    const isInstance =
      detailType === 'RDS DB Instance Event' &&
      detail.SourceType === 'DB_INSTANCE' &&
      detail.EventID === 'RDS-EVENT-0154';

    const isCluster =
      detailType === 'RDS DB Cluster Event' &&
      detail.SourceType === 'CLUSTER' &&
      detail.EventID === 'RDS-EVENT-0153';

    if (!isInstance && !isCluster) {
      throw new Error(
        `Unsupported event: detail-type=${detailType}, SourceType=${detail.SourceType}, EventID=${detail.EventID}`,
      );
    }

    // Initial delay before the first describe (allows RDS to report a stable status).
    await context.wait({ minutes: 1 });

    // Poll until the resource is no longer in a transitional status; capture status and TagList.
    const firstDescribe = await context.waitForCondition<PollState>(
      async (_state, _ctx) => {
        if (isInstance) {
          const res = await rdsClient.send(
            new DescribeDBInstancesCommand({
              DBInstanceIdentifier: detail.SourceIdentifier,
            }),
          );
          const db = res.DBInstances?.[0];
          return {
            status: db?.DBInstanceStatus ?? 'unknown',
            identifier: db?.DBInstanceIdentifier ?? detail.SourceIdentifier,
            tags: (db?.TagList ?? []) as Tag[],
          };
        }

        const res = await rdsClient.send(
          new DescribeDBClustersCommand({
            DBClusterIdentifier: detail.SourceIdentifier,
          }),
        );
        const cluster = res.DBClusters?.[0];
        return {
          status: cluster?.Status ?? 'unknown',
          identifier: cluster?.DBClusterIdentifier ?? detail.SourceIdentifier,
          tags: (cluster?.TagList ?? []) as Tag[],
        };
      },
      {
        initialState: {
          status: 'starting',
          identifier: detail.SourceIdentifier,
        },
        waitStrategy: state => {
          // Re-poll every 5 minutes while the status is still transitional.
          if (TRANSITIONAL_STATUSES.has(state.status)) {
            return { shouldContinue: true, delay: { minutes: 5 } };
          }
          // available, stopped, or other terminal status — proceed to tag check and stop logic.
          return { shouldContinue: false };
        },
      },
    );

    // Skip when TagList is missing or does not match tagKey / tagValues.
    if (!matchTag(params, firstDescribe.tags)) {
      return {
        action: 'no-op',
        reason: 'tag not matched or not found',
        status: firstDescribe.status,
      };
    }

    let didStop = false;
    let finalStatus = firstDescribe.status;

    // When available, invoke StopDB* and poll until stopped.
    if (firstDescribe.status === 'available') {
      if (isInstance) {
        await context.step('stop-db-instance', async () => {
          await rdsClient.send(
            new StopDBInstanceCommand({
              DBInstanceIdentifier: detail.SourceIdentifier,
            }),
          );
        });
      } else {
        await context.step('stop-db-cluster', async () => {
          await rdsClient.send(
            new StopDBClusterCommand({
              DBClusterIdentifier: detail.SourceIdentifier,
            }),
          );
        });
      }

      const stopped = await context.waitForCondition<PollState>(
        async (_state, _ctx) => {
          if (isInstance) {
            const res = await rdsClient.send(
              new DescribeDBInstancesCommand({
                DBInstanceIdentifier: detail.SourceIdentifier,
              }),
            );
            const db = res.DBInstances?.[0];
            return {
              status: db?.DBInstanceStatus ?? 'unknown',
              identifier: db?.DBInstanceIdentifier ?? detail.SourceIdentifier,
            };
          }

          const res = await rdsClient.send(
            new DescribeDBClustersCommand({
              DBClusterIdentifier: detail.SourceIdentifier,
            }),
          );
          const cluster = res.DBClusters?.[0];
          return {
            status: cluster?.Status ?? 'unknown',
            identifier: cluster?.DBClusterIdentifier ?? detail.SourceIdentifier,
          };
        },
        {
          initialState: {
            status: firstDescribe.status,
            identifier: firstDescribe.identifier,
          },
          waitStrategy: state => {
            if (state.status === 'stopped') {
              return { shouldContinue: false };
            }
            if (TRANSITIONAL_STATUSES.has(state.status)) {
              return { shouldContinue: true, delay: { minutes: 5 } };
            }
            throw new Error(`Unexpected status while waiting for stop: ${state.status}`);
          },
        },
      );

      didStop = true;
      finalStatus = stopped.status;
    }

    // Already stopped without calling StopDB* (e.g. stopped by another process) — no Slack notification.
    if (!didStop) {
      if (finalStatus === 'stopped') {
        return {
          action: 'no-op',
          reason: 'already stopped',
          status: finalStatus,
        };
      }
      throw new Error(`DB status is not stopped after processing: ${finalStatus}`);
    }

    // Fail when StopDB* was called but the resource did not reach stopped.
    if (finalStatus !== 'stopped') {
      throw new Error(`DB status is not stopped after processing: ${finalStatus}`);
    }

    const sourceArnParts = detail.SourceArn.split(':');
    const region = sourceArnParts[3];
    const account = sourceArnParts[4];

    const client = new WebClient(slackSecretValue.token);
    const channel = slackSecretValue.channel;

    await context.step('post-slack-messages', async () => {
      return client.chat.postMessage({
        channel,
        attachments: [
          {
            color: '#36a64f',
            pretext: `😴 Successfully stopped the automatically running RDS ${detail.SourceType} ${detail.SourceIdentifier}.`,
            fields: [
              {
                title: 'Account',
                value: account,
                short: true,
              },
              {
                title: 'Region',
                value: region,
                short: true,
              },
              {
                title: 'Type',
                value: detail.SourceType,
                short: true,
              },
              {
                title: 'Identifier',
                value: detail.SourceIdentifier,
                short: true,
              },
            ],
          },
        ],
      });
    });

    return {
      action: 'stopped',
      finalStatus,
      account,
      region,
      identifier: detail.SourceIdentifier,
    };
  },
);

