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
  DB_STATUS,
  decideAfterTagMatch,
  isSlackSecret,
  matchTag,
  normalizeInput,
  NoOpResult,
  parseRdsSourceArn,
  ResourceKind,
  resolveResourceKind,
  WaitState,
  SlackSecret,
  StoppedResult,
  Tag,
  tagMismatchNoOp,
  waitStrategyUntilStable,
  waitStrategyUntilStopped,
} from './core/auto-start-prevent.predicates';

/** Shared RDS client for describe and stop API calls. */
const rdsClient = new RDSClient({});

/**
 * Per-request timeout for Slack API calls.
 * The WebClient default is no timeout with ~30 minutes of retries, which exceeds the Lambda invocation timeout.
 */
const SLACK_REQUEST_TIMEOUT_MS = 30_000;

/** Slack retries after the first attempt, kept within the Lambda invocation timeout. */
const SLACK_RETRIES = 2;

/** Durable step names for StopDB*; kept per resource kind so existing execution histories still replay. */
const STOP_STEP_NAMES: Record<ResourceKind, string> = {
  instance: 'stop-db-instance',
  cluster: 'stop-db-cluster',
};

/**
 * Describes the DB instance or cluster and returns its status, identifier, and tags.
 * Falls back to `unknown`, the requested identifier, and no tags when the response has no resource.
 *
 * @param kind - Resource type to describe.
 * @param identifier - DB instance or cluster identifier.
 * @returns Wait state including the resource TagList.
 */
const describeResource = async (kind: ResourceKind, identifier: string): Promise<Required<WaitState>> => {
  if (kind === 'instance') {
    const res = await rdsClient.send(
      new DescribeDBInstancesCommand({
        DBInstanceIdentifier: identifier,
      }),
    );
    const db = res.DBInstances?.[0];
    return {
      status: db?.DBInstanceStatus ?? DB_STATUS.UNKNOWN,
      identifier: db?.DBInstanceIdentifier ?? identifier,
      tags: (db?.TagList ?? []) as Tag[],
    };
  }

  const res = await rdsClient.send(
    new DescribeDBClustersCommand({
      DBClusterIdentifier: identifier,
    }),
  );
  const cluster = res.DBClusters?.[0];
  return {
    status: cluster?.Status ?? DB_STATUS.UNKNOWN,
    identifier: cluster?.DBClusterIdentifier ?? identifier,
    tags: (cluster?.TagList ?? []) as Tag[],
  };
};

/**
 * Calls StopDBInstance or StopDBCluster.
 *
 * @param kind - Resource type to stop.
 * @param identifier - DB instance or cluster identifier.
 */
const stopResource = async (kind: ResourceKind, identifier: string): Promise<void> => {
  if (kind === 'instance') {
    await rdsClient.send(
      new StopDBInstanceCommand({
        DBInstanceIdentifier: identifier,
      }),
    );
    return;
  }

  await rdsClient.send(
    new StopDBClusterCommand({
      DBClusterIdentifier: identifier,
    }),
  );
};

/**
 * Durable Lambda handler for RDS auto-start prevention.
 *
 * Workflow:
 * 1. Wait 1 minute, then wait on DescribeDB* until the resource leaves transitional statuses.
 * 2. Read tags from the describe response `TagList`; skip when {@link matchTag} returns false.
 * 3. If status is `available`, call StopDB* and wait until `stopped`.
 * 4. If already `stopped` without calling StopDB*, return {@link NoOpResult} (no Slack notification).
 * 5. When `SLACK_SECRET_NAME` is set, post to Slack only after StopDB* was invoked and the resource reached `stopped`. When it is unset, skip Slack.
 *
 * Tag matching uses RDS Describe APIs only; Resource Groups Tagging API is not used.
 *
 * @param input - `{ event, params }` from EventBridge InputTransformer (same shape required for direct Invoke).
 * @param context - Durable execution context for steps and waits.
 * @returns {@link StoppedResult} or {@link NoOpResult}.
 * @throws When the payload is invalid, the event is unsupported, a configured Slack secret is invalid, or stop did not reach `stopped`.
 */
export const processAutoStartPrevent = async (
  input: unknown,
  context: DurableContext,
): Promise<StoppedResult | NoOpResult> => {
  const { event, params } = normalizeInput(input);
  const { detail, 'detail-type': detailType } = event;

  const slackSecretName = StrictEnvResolver.resolve('SLACK_SECRET_NAME', StrictEnvType.String, {
    trim: true,
    default: '',
  });
  // Requires AWS Parameters and Secrets Extension (ParamsAndSecrets layer) and
  // AWS_SESSION_TOKEN from the Lambda runtime (aws-lambda-secret-fetcher ^0.6+).
  // Fetched outside context.step: step results are persisted in the durable execution history,
  // so the token and channel must not be returned from a step. Re-fetching on replay is read-only.
  let slackSecret: SlackSecret | undefined;
  if (slackSecretName.length > 0) {
    const slackSecretValue = await secretFetcher.getSecretValue<SlackSecret>(slackSecretName);
    if (!isSlackSecret(slackSecretValue)) {
      throw new Error('Slack secret must be JSON with non-empty token and channel.');
    }
    slackSecret = slackSecretValue;
  }

  const kind = resolveResourceKind(detailType, detail);

  // Initial delay before the first describe (allows RDS to report a stable status).
  await context.wait('initial-delay', { minutes: 1 });

  // Wait until the resource is no longer in a transitional status; capture status and TagList.
  const firstDescribe = await context.waitForCondition<WaitState>(
    'wait-until-stable',
    async (_state, _ctx) => describeResource(kind, detail.SourceIdentifier),
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

  // Already stopped without calling StopDB* (e.g. stopped by another process) — no Slack notification.
  const afterTagMatch = decideAfterTagMatch(firstDescribe.status);
  if (afterTagMatch.kind === 'no-op') {
    return afterTagMatch.result;
  }
  if (afterTagMatch.kind === 'error') {
    throw new Error(afterTagMatch.message);
  }

  // Available: invoke StopDB* and wait until stopped.
  await context.step(STOP_STEP_NAMES[kind], async () => {
    await stopResource(kind, detail.SourceIdentifier);
  });

  // waitStrategyUntilStopped ends only on `stopped` and throws on any non-transitional status.
  // Tags are dropped here so they are not persisted again on every check.
  const stopped = await context.waitForCondition<WaitState>(
    'wait-until-stopped',
    async (_state, _ctx) => {
      const { status, identifier } = await describeResource(kind, detail.SourceIdentifier);
      return { status, identifier };
    },
    {
      initialState: {
        status: firstDescribe.status,
        identifier: firstDescribe.identifier,
      },
      waitStrategy: waitStrategyUntilStopped,
    },
  );

  const { region, account } = parseRdsSourceArn(detail.SourceArn);

  if (slackSecret !== undefined) {
    const channel = slackSecret.channel;
    const client = new WebClient(slackSecret.token, {
      timeout: SLACK_REQUEST_TIMEOUT_MS,
      retryConfig: { retries: SLACK_RETRIES },
    });
    // Return nothing so the Slack API response is not persisted in the durable execution history.
    await context.step('post-slack-messages', async () => {
      await client.chat.postMessage(
        buildSlackStopNotification({
          channel,
          sourceType: detail.SourceType,
          sourceIdentifier: detail.SourceIdentifier,
          account,
          region,
        }),
      );
    });
  }

  return buildStoppedResult({
    finalStatus: stopped.status,
    account,
    region,
    identifier: detail.SourceIdentifier,
  });
};

export const handler = withDurableExecution(processAutoStartPrevent);
