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

import { LocalDurableTestRunner } from '@aws/durable-execution-sdk-js-testing';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
  StopDBClusterCommand,
  StopDBInstanceCommand,
} from '@aws-sdk/client-rds';
import { WebClient } from '@slack/web-api';
import { secretFetcher } from 'aws-lambda-secret-fetcher';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { handler } from '../src/funcs/auto-start-prevent.lambda';

const postMessageMock = jest.fn().mockResolvedValue({ ok: true, ts: '1700000000.000100' });
const rdsMock = mockClient(RDSClient);
const getSecretValueMock = secretFetcher.getSecretValue as jest.MockedFunction<
  typeof secretFetcher.getSecretValue
>;

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

/** Describe responses for an available, tag-matched instance that reaches `stopped` after StopDBInstance. */
const mockInstanceStopFlow = (): void => {
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
    .resolves({
      DBInstances: [
        {
          DBInstanceIdentifier: 'demo-db',
          DBInstanceStatus: 'stopped',
        },
      ],
    });
  rdsMock.on(StopDBInstanceCommand).resolves({});
};

const runHandler = async (payload: unknown) => {
  const runner = new LocalDurableTestRunner({ handlerFunction: handler });
  const execution = await runner.run({ payload });
  return { runner, execution };
};

const expectNoStopSent = (): void => {
  expect(rdsMock).not.toHaveReceivedCommand(StopDBInstanceCommand);
  expect(rdsMock).not.toHaveReceivedCommand(StopDBClusterCommand);
};

const expectNoRdsCommandSent = (): void => {
  expect(rdsMock).not.toHaveReceivedCommand(DescribeDBInstancesCommand);
  expect(rdsMock).not.toHaveReceivedCommand(DescribeDBClustersCommand);
  expectNoStopSent();
};

describe('auto-start-prevent handler', () => {
  beforeAll(async () => {
    await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  });

  afterAll(async () => {
    await LocalDurableTestRunner.teardownTestEnvironment();
  });

  beforeEach(() => {
    rdsMock.reset();
    postMessageMock.mockClear();
    (WebClient as unknown as jest.Mock).mockClear();
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

    const { execution } = await runHandler(instanceInput);

    expect(execution.getStatus()).toBe('SUCCEEDED');
    expect(execution.getResult()).toEqual({
      action: 'no-op',
      reason: 'tag not matched or not found',
      status: 'available',
    });
    expectNoStopSent();
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

    const { execution } = await runHandler(instanceInput);

    expect(execution.getStatus()).toBe('SUCCEEDED');
    expect(execution.getResult()).toEqual({
      action: 'no-op',
      reason: 'already stopped',
      status: 'stopped',
    });
    expectNoStopSent();
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('stops an available instance, waits until stopped, and posts Slack', async () => {
    mockInstanceStopFlow();

    const { execution } = await runHandler(instanceInput);

    expect(execution.getStatus()).toBe('SUCCEEDED');
    expect(execution.getResult()).toEqual({
      action: 'stopped',
      finalStatus: 'stopped',
      account: '123456789012',
      region: 'ap-northeast-1',
      identifier: 'demo-db',
    });
    expect(rdsMock).toHaveReceivedCommandTimes(StopDBInstanceCommand, 1);
    expect(rdsMock).toHaveReceivedCommandWith(StopDBInstanceCommand, {
      DBInstanceIdentifier: 'demo-db',
    });
    expect(WebClient).toHaveBeenCalledWith('xoxb-test-token', {
      timeout: 30_000,
      retryConfig: { retries: 2 },
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
      .resolves({
        DBClusters: [
          {
            DBClusterIdentifier: 'demo-cluster',
            Status: 'stopped',
          },
        ],
      });
    rdsMock.on(StopDBClusterCommand).resolves({});

    const { runner, execution } = await runHandler(clusterInput);

    expect(execution.getStatus()).toBe('SUCCEEDED');
    expect(execution.getResult()).toEqual({
      action: 'stopped',
      finalStatus: 'stopped',
      account: '111122223333',
      region: 'us-east-1',
      identifier: 'demo-cluster',
    });
    expect(runner.getOperation('stop-db-cluster').getStepDetails()?.error).toBeUndefined();
    expect(rdsMock).toHaveReceivedCommandTimes(StopDBClusterCommand, 1);
    expect(rdsMock).toHaveReceivedCommandWith(StopDBClusterCommand, {
      DBClusterIdentifier: 'demo-cluster',
    });
    expect(postMessageMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the Slack secret and Slack response out of the durable execution history', async () => {
    mockInstanceStopFlow();

    const { runner, execution } = await runHandler(instanceInput);

    expect(execution.getStatus()).toBe('SUCCEEDED');
    const operationNames = execution.getOperations().map((operation) => operation.getName());
    expect(operationNames).not.toContain('fetch-slack-secret');
    expect(runner.getOperation('post-slack-messages').getStepDetails()?.result).toBeUndefined();

    const history = JSON.stringify(execution.getHistoryEvents());
    expect(history).toContain('demo-db');
    expect(history).not.toContain('xoxb-test-token');
    expect(history).not.toContain('C-TEST');
    expect(history).not.toContain('1700000000.000100');
    expect(getSecretValueMock).toHaveBeenCalledWith('example/slack/secret');
  });

  it('runs the named durable operations in order', async () => {
    mockInstanceStopFlow();

    const { runner, execution } = await runHandler(instanceInput);

    expect(execution.getStatus()).toBe('SUCCEEDED');
    expect(execution.getOperations().map((operation) => operation.getName())).toEqual([
      'initial-delay',
      'wait-until-stable',
      'stop-db-instance',
      'wait-until-stopped',
      'post-slack-messages',
    ]);
    expect(runner.getOperation('initial-delay').getWaitDetails()?.waitSeconds).toBe(60);
  });

  it.each([
    ['instance', instanceInput, () => rdsMock.on(DescribeDBInstancesCommand).resolves({ DBInstances: [] })],
    ['cluster', clusterInput, () => rdsMock.on(DescribeDBClustersCommand).resolves({ DBClusters: [] })],
  ])('returns tag mismatch no-op with unknown status when the %s describe is empty', async (_kind, input, mockEmptyDescribe) => {
    mockEmptyDescribe();

    const { execution } = await runHandler(input);

    expect(execution.getStatus()).toBe('SUCCEEDED');
    expect(execution.getResult()).toEqual({
      action: 'no-op',
      reason: 'tag not matched or not found',
      status: 'unknown',
    });
    expectNoStopSent();
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('fails for unsupported event combinations', async () => {
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

    const { execution } = await runHandler(unsupported);

    expect(execution.getStatus()).toBe('FAILED');
    expect(execution.getError().errorMessage).toMatch(/Unsupported event/);
    expectNoRdsCommandSent();
  });

  it('fails when matched tags but status is neither available nor stopped', async () => {
    rdsMock.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [
        {
          DBInstanceIdentifier: 'demo-db',
          DBInstanceStatus: 'storage-full',
          TagList: [{ Key: 'AutoStartPrevent', Value: 'YES' }],
        },
      ],
    });

    const { execution } = await runHandler(instanceInput);

    expect(execution.getStatus()).toBe('FAILED');
    expect(execution.getError().errorMessage).toBe(
      'Cannot stop DB demo-db: status is storage-full, expected available or stopped.',
    );
    expectNoStopSent();
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('fails when Slack secret shape is invalid', async () => {
    getSecretValueMock.mockResolvedValue('not-json' as unknown as never);

    const { execution } = await runHandler(instanceInput);

    expect(execution.getStatus()).toBe('FAILED');
    expect(execution.getError().errorMessage).toBe('Slack secret must be JSON with non-empty token and channel.');
    expectNoRdsCommandSent();
  });

  it('fails when input is not { event, params }', async () => {
    const { execution } = await runHandler(instanceInput.event);

    expect(execution.getStatus()).toBe('FAILED');
    expect(execution.getError().errorMessage).toBe('Invalid input: expected { event, params }.');
    expectNoRdsCommandSent();
  });

  it('stops an available instance without Slack when SLACK_SECRET_NAME is missing', async () => {
    delete process.env.SLACK_SECRET_NAME;
    mockInstanceStopFlow();

    const { execution } = await runHandler(instanceInput);

    expect(execution.getStatus()).toBe('SUCCEEDED');
    expect(execution.getResult()).toEqual({
      action: 'stopped',
      finalStatus: 'stopped',
      account: '123456789012',
      region: 'ap-northeast-1',
      identifier: 'demo-db',
    });
    expect(rdsMock).toHaveReceivedCommandWith(StopDBInstanceCommand, {
      DBInstanceIdentifier: 'demo-db',
    });
    expect(execution.getOperations().map((operation) => operation.getName())).not.toContain('post-slack-messages');
    expect(getSecretValueMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
  });
});
