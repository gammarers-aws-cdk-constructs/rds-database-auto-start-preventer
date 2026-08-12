/**
 * Pure helpers for the RDS auto-start prevent Lambda.
 * No AWS SDK, Durable context, env, or clock dependencies.
 */

/**
 * Detail payload of an RDS auto-start event from EventBridge.
 */
export interface RdsAutoStartDetail {
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
export interface RdsAutoStartEvent {
  'detail-type': 'RDS DB Instance Event' | 'RDS DB Cluster Event';
  'source': 'aws.rds';
  'detail': RdsAutoStartDetail;
}

/**
 * Tag-based filter parameters for the handler.
 */
export interface AutoStartParams {
  /** Tag key to match on the resource. */
  tagKey: string;
  /** Allowed tag values; the resource is processed only when its tag value is in this list. */
  tagValues: string[];
}

/**
 * Slack credentials stored in Secrets Manager.
 */
export interface SlackSecret {
  /** Slack bot or user OAuth token. */
  token: string;
  /** Channel ID or name to post notifications to. */
  channel: string;
}

/**
 * Normalized handler input: EventBridge event and tag filter parameters.
 */
export interface AutoStartPreventInput {
  event: RdsAutoStartEvent;
  params: AutoStartParams;
}

/**
 * Handler result when no stop action was taken.
 */
export interface NoOpResult {
  action: 'no-op';
  reason: 'tag not matched or not found' | 'already stopped';
  status: string;
}

/**
 * Handler result when this invocation called StopDB* and the resource reached `stopped`.
 */
export interface StoppedResult {
  action: 'stopped';
  finalStatus: string;
  account: string;
  region: string;
  identifier: string;
}

/**
 * AWS-style tag (Key/Value).
 */
export interface Tag {
  Key?: string;
  Value?: string;
}

/**
 * State snapshot while polling RDS describe APIs.
 */
export interface PollState {
  /** Current DB instance or cluster status. */
  status: string;
  /** DB instance or cluster identifier. */
  identifier: string;
  /** Tags from the describe response; present on the first poll only. */
  tags?: Tag[];
}

/** Continue polling with a delay. */
export interface ContinueWait {
  shouldContinue: true;
  delay: { minutes: number };
}

/** Stop polling. */
export interface StopWait {
  shouldContinue: false;
}

/** Result of a durable waitStrategy. */
export type WaitStrategyResult = ContinueWait | StopWait;

/**
 * RDS statuses that indicate an in-progress transition.
 * The handler polls every 5 minutes while the resource remains in one of these states.
 */
export const TRANSITIONAL_STATUSES = new Set([
  'starting',
  'configuring-enhanced-monitoring',
  'backing-up',
  'modifying',
  'stopping',
]);

/**
 * Returns true when the status is transitional and polling should continue.
 *
 * @param status - Current DB instance or cluster status.
 * @returns Whether the status is transitional.
 */
export const isTransitionalStatus = (status: string): boolean =>
  TRANSITIONAL_STATUSES.has(status);

/**
 * Type guard for Slack credentials returned by `secretFetcher.getSecretValue`.
 *
 * aws-lambda-secret-fetcher ^0.7 parses SecretString with quiet-json-parser and
 * falls back to the raw string on invalid JSON, so callers must validate shape.
 *
 * @param value - Value returned from the secret fetcher.
 * @returns Whether value is a SlackSecret with non-empty token and channel.
 */
export const isSlackSecret = (value: unknown): value is SlackSecret => {
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
 * Type guard: input is `{ event, params }` as produced by the EventBridge target.
 *
 * @param input - Raw Lambda invocation payload.
 * @returns Whether input has non-null event and params.
 */
export const isAutoStartPreventInput = (input: unknown): input is AutoStartPreventInput => {
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
export const normalizeInput = (input: unknown): AutoStartPreventInput => {
  if (isAutoStartPreventInput(input)) {
    return input;
  }
  throw new Error('Invalid input: expected { event, params }.');
};

/**
 * Returns true if the resource has a tag with the given key and a value in the allowed list.
 *
 * @param params - Tag key and allowed values.
 * @param tags - Resource tag list (e.g. from DescribeDBInstances / DescribeDBClusters).
 * @returns Whether the tag matches.
 */
export const matchTag = (params: AutoStartParams, tags?: Tag[]): boolean => {
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
 * Whether the EventBridge detail identifies a supported DB instance auto-start event.
 *
 * @param detailType - EventBridge detail-type.
 * @param detail - RDS event detail.
 * @returns True for RDS-EVENT-0154 on a DB instance.
 */
export const isDbInstanceAutoStart = (
  detailType: RdsAutoStartEvent['detail-type'],
  detail: RdsAutoStartDetail,
): boolean =>
  detailType === 'RDS DB Instance Event' &&
  detail.SourceType === 'DB_INSTANCE' &&
  detail.EventID === 'RDS-EVENT-0154';

/**
 * Whether the EventBridge detail identifies a supported DB cluster auto-start event.
 *
 * @param detailType - EventBridge detail-type.
 * @param detail - RDS event detail.
 * @returns True for RDS-EVENT-0153 on a cluster.
 */
export const isDbClusterAutoStart = (
  detailType: RdsAutoStartEvent['detail-type'],
  detail: RdsAutoStartDetail,
): boolean =>
  detailType === 'RDS DB Cluster Event' &&
  detail.SourceType === 'CLUSTER' &&
  detail.EventID === 'RDS-EVENT-0153';

/**
 * Wait strategy while describing until the resource leaves transitional statuses.
 *
 * @param state - Latest poll state.
 * @returns Continue every 5 minutes while transitional; otherwise stop.
 */
export const waitStrategyUntilStable = (state: PollState): WaitStrategyResult => {
  if (isTransitionalStatus(state.status)) {
    return { shouldContinue: true, delay: { minutes: 5 } };
  }
  return { shouldContinue: false };
};

/**
 * Wait strategy after StopDB* until the resource reaches `stopped`.
 *
 * @param state - Latest poll state.
 * @returns Stop when `stopped`; continue while transitional.
 * @throws When the status is neither stopped nor transitional.
 */
export const waitStrategyUntilStopped = (state: PollState): WaitStrategyResult => {
  if (state.status === 'stopped') {
    return { shouldContinue: false };
  }
  if (isTransitionalStatus(state.status)) {
    return { shouldContinue: true, delay: { minutes: 5 } };
  }
  throw new Error(`Unexpected status while waiting for stop: ${state.status}`);
};

/**
 * Decision after the first describe and a successful tag match.
 */
export type AfterTagMatchDecision =
  | { kind: 'stop' }
  | { kind: 'no-op'; result: NoOpResult }
  | { kind: 'error'; message: string };

/**
 * Decides the next action when tags matched and StopDB* has not been called yet.
 *
 * @param status - Status from the first describe after leaving transitional states.
 * @returns Stop when `available`; no-op when already `stopped`; otherwise error.
 */
export const decideAfterTagMatch = (status: string): AfterTagMatchDecision => {
  if (status === 'available') {
    return { kind: 'stop' };
  }
  if (status === 'stopped') {
    return {
      kind: 'no-op',
      result: {
        action: 'no-op',
        reason: 'already stopped',
        status,
      },
    };
  }
  return {
    kind: 'error',
    message: `DB status is not stopped after processing: ${status}`,
  };
};

/**
 * Builds the no-op result used when tags do not match.
 *
 * @param status - Current resource status.
 * @returns No-op result with tag mismatch reason.
 */
export const tagMismatchNoOp = (status: string): NoOpResult => ({
  action: 'no-op',
  reason: 'tag not matched or not found',
  status,
});

/**
 * Parses region and account from an RDS resource ARN (`arn:aws:rds:region:account:...`).
 *
 * @param sourceArn - SourceArn from the RDS event detail.
 * @returns Region and account id segments.
 */
export const parseRdsSourceArn = (sourceArn: string): { region: string; account: string } => {
  const parts = sourceArn.split(':');
  return {
    region: parts[3] ?? '',
    account: parts[4] ?? '',
  };
};

/**
 * Arguments for the Slack stop-success notification.
 */
export interface SlackStopNotificationArgs {
  channel: string;
  sourceType: RdsAutoStartDetail['SourceType'];
  sourceIdentifier: string;
  account: string;
  region: string;
}

/**
 * Builds the Slack `chat.postMessage` payload after a successful stop.
 *
 * @param args - Channel and resource identity fields.
 * @returns Arguments suitable for `WebClient.chat.postMessage`.
 */
export const buildSlackStopNotification = (args: SlackStopNotificationArgs) => ({
  channel: args.channel,
  attachments: [
    {
      color: '#36a64f',
      pretext: `😴 Successfully stopped the automatically running RDS ${args.sourceType} ${args.sourceIdentifier}.`,
      fields: [
        {
          title: 'Account',
          value: args.account,
          short: true,
        },
        {
          title: 'Region',
          value: args.region,
          short: true,
        },
        {
          title: 'Type',
          value: args.sourceType,
          short: true,
        },
        {
          title: 'Identifier',
          value: args.sourceIdentifier,
          short: true,
        },
      ],
    },
  ],
});

/**
 * Builds the success result after StopDB* reached `stopped`.
 *
 * @param args - Final status and identity fields.
 * @returns StoppedResult for the handler return value.
 */
export const buildStoppedResult = (args: {
  finalStatus: string;
  account: string;
  region: string;
  identifier: string;
}): StoppedResult => ({
  action: 'stopped',
  finalStatus: args.finalStatus,
  account: args.account,
  region: args.region,
  identifier: args.identifier,
});
