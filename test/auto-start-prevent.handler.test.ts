jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: postMessageMock },
  })),
}));

jest.mock('aws-lambda-secret-fetcher', () => ({
  secretFetcher: {
    getSecretValue: jest.fn(),
  },
}));

import { DurableContext } from '@aws/durable-execution-sdk-js';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
  StopDBClusterCommand,
  StopDBInstanceCommand,
} from '@aws-sdk/client-rds';
import { secretFetcher } from 'aws-lambda-secret-fetcher';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { processAutoStartPrevent } from '../src/funcs/auto-start-prevent.lambda';

const postMessageMock = jest.fn().mockResolvedValue({ ok: true });
const rdsMock = mockClient(RDSClient);
const getSecretValueMock = secretFetcher.getSecretValue as jest.MockedFunction<
  typeof secretFetcher.getSecretValue
>;

type WaitStrategyResult = { shouldContinue: true; delay: unknown } | { shouldContinue: false };

/**
 * Minimal DurableContext that runs steps immediately and evaluates waitForCondition locally.
 */
const createFakeDurableContext = (): DurableContext => {
  const context = {
    step: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    wait: jest.fn(async () => undefined),
    waitForCondition: jest.fn(
      async <T>(
        checkFn: (state: T, ctx: DurableContext) => Promise<T>,
        config: {
          initialState: T;
          waitStrategy: (state: T) => WaitStrategyResult;
        },
      ): Promise<T> => {
        let state = config.initialState;
        for (let i = 0; i < 20; i += 1) {
          state = await checkFn(state, context as DurableContext);
          const strategy = config.waitStrategy(state);
          if (!strategy.shouldContinue) {
            return state;
          }
        }
        throw new Error('waitForCondition exceeded max iterations in test double');
      },
    ),
  };
  return context as unknown as DurableContext;
};

const instanceInput = {
  event: {
    'detail-type': 'RDS DB Instance Event' as const,
    'source': 'aws.rds' as const,
    'detail': {
      EventID: 'RDS-EVENT-0154' as const,
      SourceType: 'DB_INSTANCE' as const,
      SourceArn: 'arn:aws:rds:ap-northeast-1:123456789012:db:demo-db',
      SourceIdentifier: 'demo-db',
    },
  },
  params: {
    tagKey: 'AutoStartPrevent',
    tagValues: ['YES'],
  },
};

const clusterInput = {
  event: {
    'detail-type': 'RDS DB Cluster Event' as const,
    'source': 'aws.rds' as const,
    'detail': {
      EventID: 'RDS-EVENT-0153' as const,
      SourceType: 'CLUSTER' as const,
      SourceArn: 'arn:aws:rds:us-east-1:111122223333:cluster:demo-cluster',
      SourceIdentifier: 'demo-cluster',
    },
  },
  params: {
    tagKey: 'AutoStartPrevent',
    tagValues: ['YES'],
  },
};

describe('processAutoStartPrevent', () => {
  beforeEach(() => {
    rdsMock.reset();
    postMessageMock.mockClear();
    getSecretValueMock.mockReset();
    process.env.SLACK_SECRET_NAME = 'example/slack/secret';
    getSecretValueMock.mockResolvedValue({
      token: 'xoxb-test-token',
      channel: 'C-TEST',
    });
  });

  afterEach(() => {
    delete process.env.SLACK_SECRET_NAME;
  });

  it('returns tag mismatch no-op without stopping or notifying Slack', async () => {
    rdsMock.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [
        {
          DBInstanceIdentifier: 'demo-db',
          DBInstanceStatus: 'available',
          TagList: [{ Key: 'AutoStartPrevent', Value: 'NO' }],
        },
      ],
    });

    const result = await processAutoStartPrevent(instanceInput, createFakeDurableContext());

    expect(result).toEqual({
      action: 'no-op',
      reason: 'tag not matched or not found',
      status: 'available',
    });
    expect(rdsMock).not.toHaveReceivedCommand(StopDBInstanceCommand);
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('returns already-stopped no-op without Slack when status is stopped', async () => {
    rdsMock.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [
        {
          DBInstanceIdentifier: 'demo-db',
          DBInstanceStatus: 'stopped',
          TagList: [{ Key: 'AutoStartPrevent', Value: 'YES' }],
        },
      ],
    });

    const result = await processAutoStartPrevent(instanceInput, createFakeDurableContext());

    expect(result).toEqual({
      action: 'no-op',
      reason: 'already stopped',
      status: 'stopped',
    });
    expect(rdsMock).not.toHaveReceivedCommand(StopDBInstanceCommand);
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('stops an available instance, waits until stopped, and posts Slack', async () => {
    rdsMock
      .on(DescribeDBInstancesCommand)
      .resolvesOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: 'demo-db',
            DBInstanceStatus: 'available',
            TagList: [{ Key: 'AutoStartPrevent', Value: 'YES' }],
          },
        ],
      })
      .resolvesOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: 'demo-db',
            DBInstanceStatus: 'stopping',
          },
        ],
      })
      .resolvesOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: 'demo-db',
            DBInstanceStatus: 'stopped',
          },
        ],
      });
    rdsMock.on(StopDBInstanceCommand).resolves({});

    const result = await processAutoStartPrevent(instanceInput, createFakeDurableContext());

    expect(result).toEqual({
      action: 'stopped',
      finalStatus: 'stopped',
      account: '123456789012',
      region: 'ap-northeast-1',
      identifier: 'demo-db',
    });
    expect(rdsMock).toHaveReceivedCommandWith(StopDBInstanceCommand, {
      DBInstanceIdentifier: 'demo-db',
    });
    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-TEST',
        attachments: expect.arrayContaining([
          expect.objectContaining({
            pretext: expect.stringContaining('demo-db'),
          }),
        ]),
      }),
    );
  });

  it('stops an available cluster and posts Slack', async () => {
    rdsMock
      .on(DescribeDBClustersCommand)
      .resolvesOnce({
        DBClusters: [
          {
            DBClusterIdentifier: 'demo-cluster',
            Status: 'available',
            TagList: [{ Key: 'AutoStartPrevent', Value: 'YES' }],
          },
        ],
      })
      .resolvesOnce({
        DBClusters: [
          {
            DBClusterIdentifier: 'demo-cluster',
            Status: 'stopped',
          },
        ],
      });
    rdsMock.on(StopDBClusterCommand).resolves({});

    const result = await processAutoStartPrevent(clusterInput, createFakeDurableContext());

    expect(result).toEqual({
      action: 'stopped',
      finalStatus: 'stopped',
      account: '111122223333',
      region: 'us-east-1',
      identifier: 'demo-cluster',
    });
    expect(rdsMock).toHaveReceivedCommandWith(StopDBClusterCommand, {
      DBClusterIdentifier: 'demo-cluster',
    });
    expect(postMessageMock).toHaveBeenCalledTimes(1);
  });

  it('throws for unsupported event combinations', async () => {
    const unsupported = {
      ...instanceInput,
      event: {
        ...instanceInput.event,
        detail: {
          ...instanceInput.event.detail,
          EventID: 'RDS-EVENT-0153' as const,
        },
      },
    };

    await expect(
      processAutoStartPrevent(unsupported, createFakeDurableContext()),
    ).rejects.toThrow(/Unsupported event/);
  });

  it('throws when matched tags but status is neither available nor stopped', async () => {
    rdsMock.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [
        {
          DBInstanceIdentifier: 'demo-db',
          DBInstanceStatus: 'storage-full',
          TagList: [{ Key: 'AutoStartPrevent', Value: 'YES' }],
        },
      ],
    });

    await expect(
      processAutoStartPrevent(instanceInput, createFakeDurableContext()),
    ).rejects.toThrow('DB status is not stopped after processing: storage-full');
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('throws when Slack secret shape is invalid', async () => {
    getSecretValueMock.mockResolvedValue('not-json' as unknown as never);

    await expect(
      processAutoStartPrevent(instanceInput, createFakeDurableContext()),
    ).rejects.toThrow('Slack secret must be JSON with non-empty token and channel.');
  });

  it('throws when input is not { event, params }', async () => {
    await expect(
      processAutoStartPrevent(instanceInput.event, createFakeDurableContext()),
    ).rejects.toThrow('Invalid input: expected { event, params }.');
  });

  it('throws when SLACK_SECRET_NAME is missing', async () => {
    delete process.env.SLACK_SECRET_NAME;

    await expect(
      processAutoStartPrevent(instanceInput, createFakeDurableContext()),
    ).rejects.toThrow(/SLACK_SECRET_NAME/);
  });
});
