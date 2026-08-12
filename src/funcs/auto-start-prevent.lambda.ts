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
import { StrictEnvResolver, StrictEnvType } from 'strict-env-resolver';
import {
  buildSlackStopNotification,
  buildStoppedResult,
  decideAfterTagMatch,
  isDbClusterAutoStart,
  isDbInstanceAutoStart,
  isSlackSecret,
  matchTag,
  normalizeInput,
  NoOpResult,
  parseRdsSourceArn,
  PollState,
  SlackSecret,
  StoppedResult,
  Tag,
  tagMismatchNoOp,
  waitStrategyUntilStable,
  waitStrategyUntilStopped,
} from './auto-start-prevent.predicates';

/** Shared RDS client for describe and stop API calls. */
const rdsClient = new RDSClient({});

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
 * @throws When the payload is invalid, required env vars are missing, the event is unsupported, secrets are invalid, or stop did not reach `stopped`.
 */
export const processAutoStartPrevent = async (
  input: unknown,
  context: DurableContext,
): Promise<StoppedResult | NoOpResult> => {
  const { event, params } = normalizeInput(input);
  const { detail, 'detail-type': detailType } = event;

  const slackSecretName = StrictEnvResolver.resolve('SLACK_SECRET_NAME', StrictEnvType.String, {
    trim: true,
  });
  // Requires AWS Parameters and Secrets Extension (ParamsAndSecrets layer) and
  // AWS_SESSION_TOKEN from the Lambda runtime (aws-lambda-secret-fetcher ^0.6+).
  const slackSecretValue = await context.step('fetch-slack-secret', async () => {
    return secretFetcher.getSecretValue<SlackSecret>(slackSecretName);
  });

  if (!isSlackSecret(slackSecretValue)) {
    throw new Error('Slack secret must be JSON with non-empty token and channel.');
  }

  const isInstance = isDbInstanceAutoStart(detailType, detail);
  const isCluster = isDbClusterAutoStart(detailType, detail);

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
      waitStrategy: waitStrategyUntilStable,
    },
  );

  // Skip when TagList is missing or does not match tagKey / tagValues.
  if (!matchTag(params, firstDescribe.tags)) {
    return tagMismatchNoOp(firstDescribe.status);
  }

  let didStop = false;
  let finalStatus = firstDescribe.status;

  // When available, invoke StopDB* and poll until stopped.
  const afterTagMatch = decideAfterTagMatch(firstDescribe.status);
  if (afterTagMatch.kind === 'stop') {
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
        waitStrategy: waitStrategyUntilStopped,
      },
    );

    didStop = true;
    finalStatus = stopped.status;
  }

  // Already stopped without calling StopDB* (e.g. stopped by another process) — no Slack notification.
  if (!didStop) {
    if (afterTagMatch.kind === 'no-op') {
      return afterTagMatch.result;
    }
    if (afterTagMatch.kind === 'error') {
      throw new Error(afterTagMatch.message);
    }
  }

  // Fail when StopDB* was called but the resource did not reach stopped.
  if (finalStatus !== 'stopped') {
    throw new Error(`DB status is not stopped after processing: ${finalStatus}`);
  }

  const { region, account } = parseRdsSourceArn(detail.SourceArn);

  const client = new WebClient(slackSecretValue.token);

  await context.step('post-slack-messages', async () => {
    return client.chat.postMessage(
      buildSlackStopNotification({
        channel: slackSecretValue.channel,
        sourceType: detail.SourceType,
        sourceIdentifier: detail.SourceIdentifier,
        account,
        region,
      }),
    );
  });

  return buildStoppedResult({
    finalStatus,
    account,
    region,
    identifier: detail.SourceIdentifier,
  });
};

export const handler = withDurableExecution(processAutoStartPrevent);
