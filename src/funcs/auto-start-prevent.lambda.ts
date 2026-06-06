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
 * Detail payload of an RDS auto-start event from EventBridge (subset used by this handler).
 */
interface RdsAutoStartDetail {
  EventID: 'RDS-EVENT-0154' | 'RDS-EVENT-0153';
  SourceType: 'DB_INSTANCE' | 'CLUSTER';
  SourceArn: string;
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
 * Parameters equivalent to those previously passed from Step Functions (tag-based filtering).
 */
interface AutoStartParams {
  tagKey: string;
  tagValues: string[];
}

/**
 * Slack secret shape stored in Secrets Manager (token and channel).
 */
interface SlackSecret {
  token: string;
  channel: string;
}

/**
 * Input to the Lambda Durable Function. Either:
 * - EventBridge passes the raw RDS event; params are taken from env (TAG_KEY, TAG_VALUES).
 * - Or caller can pass { event, params } directly.
 */
interface AutoStartPreventInput {
  event: RdsAutoStartEvent;
  params: AutoStartParams;
}

/** Detect if the payload is the raw EventBridge event (has detail + detail-type). */
const isRawEvent = (input: unknown): input is RdsAutoStartEvent =>
  typeof input === 'object' &&
  input != null &&
  'detail' in input &&
  'detail-type' in input;

/** Build params from environment (set by CDK from targetResource). */
const paramsFromEnv = (): AutoStartParams => {
  const tagKey = process.env.TAG_KEY;
  const tagValuesJson = process.env.TAG_VALUES;
  if (!tagKey || !tagValuesJson) {
    throw new Error('missing environment variables TAG_KEY or TAG_VALUES.');
  }
  let tagValues: string[];
  try {
    tagValues = JSON.parse(tagValuesJson) as string[];
  } catch {
    throw new Error('TAG_VALUES must be a JSON array of strings.');
  }
  if (!Array.isArray(tagValues)) {
    throw new Error('TAG_VALUES must be a JSON array of strings.');
  }
  return { tagKey, tagValues };
};

/** Normalize invocation input to AutoStartPreventInput (event + params). */
const normalizeInput = (input: unknown): AutoStartPreventInput => {
  if (isRawEvent(input)) {
    return { event: input, params: paramsFromEnv() };
  }
  const candidate = input as AutoStartPreventInput;
  if (
    typeof candidate === 'object' &&
    candidate != null &&
    candidate.event != null &&
    candidate.params != null
  ) {
    return candidate;
  }
  throw new Error('Invalid input: expected RDS event or { event, params }.');
};

/**
 * AWS-style tag (Key/Value).
 */
interface Tag {
  Key?: string;
  Value?: string;
}

/**
 * State used when polling RDS describe results (status, identifier, optional tags).
 */
interface PollState {
  status: string;
  identifier: string;
  tags?: Tag[];
}

const rdsClient = new RDSClient({});

/** RDS statuses that indicate a transition in progress; we poll every 5 minutes while in these states. */
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
 * Durable Lambda handler: on RDS auto-start events, waits for the resource to become available
 * (or already stopped), checks tag match, stops the instance/cluster if needed, then posts to Slack.
 *
 * @param input - EventBridge event plus params (tagKey, tagValues).
 * @param context - Durable execution context for steps and waits.
 * @returns Result with action ('stopped' | 'no-op'), finalStatus, account, region, identifier.
 */
export const handler = withDurableExecution(
  async (input: unknown, context: DurableContext) => {
    const { event, params } = normalizeInput(input);
    const { detail, 'detail-type': detailType } = event;

    const slackSecretName = process.env.SLACK_SECRET_NAME;
    if (!slackSecretName) {
      throw new Error('missing environment variable SLACK_SECRET_NAME.');
    }
    const slackSecretValue = await context.step('fetch-slack-secret', async () => {
      return secretFetcher.getSecretValue<SlackSecret>(slackSecretName);
    });

    if (!slackSecretValue?.token || !slackSecretValue?.channel) {
      throw new Error('Slack secret must contain token and channel.');
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

    // Step Functions の StartingWait (1 分待つ) に相当
    await context.wait({ minutes: 1 });

    // Step Functions の DescribeTypeChoice + TagMatchChoice + StatusChoice の前半に相当
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
          // ステータスが遷移中であれば 5 分おきにポーリング
          if (TRANSITIONAL_STATUSES.has(state.status)) {
            return { shouldContinue: true, delay: { minutes: 5 } };
          }
          // available / stopped / その他 → ここで一旦ループ終了し、後続ロジックへ
          return { shouldContinue: false };
        },
      },
    );

    // タグが存在しない or マッチしない場合は何もせず終了
    if (!matchTag(params, firstDescribe.tags)) {
      return {
        action: 'no-op',
        reason: 'tag not matched or not found',
        status: firstDescribe.status,
      };
    }

    let finalStatus = firstDescribe.status;

    // available の場合は stop API を呼び、その後 stopped になるまで待機
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

      finalStatus = stopped.status;
    }

    // stopped になっていなければ通知は出さない（Step Functions の Fail 相当）
    if (finalStatus !== 'stopped') {
      throw new Error(`DB status is not stopped after processing: ${finalStatus}`);
    }

    // 通知用の account/region 取得（Slack 投稿用）
    const sourceArnParts = detail.SourceArn.split(':');
    const region = sourceArnParts[3];
    const account = sourceArnParts[4];

    // const sourceTypeHuman = humanReadableSourceType(detail.SourceType);

    const client = new WebClient(slackSecretValue.token);
    const channel = slackSecretValue.channel;

    // send slack message
    // const slackParentMessageResult =
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

