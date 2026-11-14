import { App, Lazy, Stack, Token } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import {
  RDSDatabaseAutoStartPreventer,
  RDSDatabaseAutoStartPreventStack,
  RDSDatabaseAutoStartPreventStackProps,
} from '../src';

/**
 * Asserts the wiring every stack needs: one durable function invoked by both auto-start rules
 * through the `live` alias (qualified ARN), not `$LATEST`.
 */
const expectDurableWiring = (template: Template): void => {
  template.resourceCountIs('AWS::Lambda::Function', 1);
  template.resourceCountIs('AWS::Lambda::Version', 1);
  template.resourceCountIs('AWS::Lambda::Alias', 1);
  template.resourceCountIs('AWS::Lambda::Permission', 2);
  template.resourceCountIs('AWS::Events::Rule', 2);

  template.hasResourceProperties('AWS::Lambda::Function', {
    DurableConfig: {
      ExecutionTimeout: 7200,
      RetentionPeriodInDays: 1,
    },
  });
  template.hasResourceProperties('AWS::Lambda::Alias', { Name: 'live' });

  const [aliasLogicalId] = Object.keys(template.findResources('AWS::Lambda::Alias'));
  const aliasTarget = Match.objectLike({
    Arn: { Ref: aliasLogicalId },
    RetryPolicy: { MaximumRetryAttempts: 2 },
  });

  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      'source': ['aws.rds'],
      'detail-type': ['RDS DB Instance Event'],
      'detail': { EventID: ['RDS-EVENT-0154'] },
    },
    Targets: [aliasTarget],
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      'source': ['aws.rds'],
      'detail-type': ['RDS DB Cluster Event'],
      'detail': { EventID: ['RDS-EVENT-0153'] },
    },
    Targets: [aliasTarget],
  });
};

describe('Stack', () => {
  describe('Default', () => {
    const app = new App();
    const stack = new RDSDatabaseAutoStartPreventStack(app, 'RDSDatabaseAutoStartPreventStack', {
      secrets: {
        slackSecretName: 'example/slack/webhook',
      },
      targetResource: {
        tagKey: 'AutoRunningStop',
        tagValues: ['YES'],
      },
    });
    const template = Template.fromStack(stack);

    it('should have lambda function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
        Description: 'A function to prevent the RDS Database or Cluster from starting automatically.',
        Architectures: ['arm64'],
        Timeout: 180,
        MemorySize: 512,
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            SLACK_SECRET_NAME: 'example/slack/webhook',
          }),
        }),
      }));
    });

    it('wires both auto-start rules to the durable function alias', () => {
      expectDurableWiring(template);
    });

    it('should have event rules enabled', () => {
      const rules = template.findResources('AWS::Events::Rule');
      const ruleProps = Object.values(rules).map((r: { Properties?: { State?: string } }) => r.Properties?.State);
      expect(ruleProps).toContain('ENABLED');
      expect(ruleProps.every((s: string | undefined) => s === 'ENABLED')).toBe(true);
    });

    it('retains the Lambda log group after create (RetainExceptOnCreate)', () => {
      template.hasResource('AWS::Logs::LogGroup', {
        DeletionPolicy: 'RetainExceptOnCreate',
        UpdateReplacePolicy: 'Retain',
        Properties: Match.objectLike({
          RetentionInDays: 90,
        }),
      });
    });

    it('scopes RDS describe to db/cluster ARNs and stop to matching ResourceTag', () => {
      const rdsArn = (resourceSuffix: ':db:*' | ':cluster:*') => ({
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':rds:',
            { Ref: 'AWS::Region' },
            ':',
            { Ref: 'AWS::AccountId' },
            resourceSuffix,
          ],
        ],
      });
      const rdsDbAndClusterArns = [rdsArn(':db:*'), rdsArn(':cluster:*')];

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Sid: 'RdsDescribeForTagFilter',
              Effect: 'Allow',
              Action: [
                'rds:DescribeDBInstances',
                'rds:DescribeDBClusters',
              ],
              Resource: rdsDbAndClusterArns,
            },
            {
              Sid: 'RdsStopTaggedTargets',
              Effect: 'Allow',
              Action: [
                'rds:StopDBInstance',
                'rds:StopDBCluster',
              ],
              Resource: rdsDbAndClusterArns,
              Condition: {
                StringEquals: {
                  'aws:ResourceTag/AutoRunningStop': ['YES'],
                },
              },
            },
          ]),
        },
      });
    });

    it('should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });
  });

  describe('Disable', () => {
    const app = new App();
    const stack = new RDSDatabaseAutoStartPreventStack(app, 'RDSDatabaseAutoStartPreventStack', {
      enableRule: false,
      targetResource: {
        tagKey: 'AutoRunningStop',
        tagValues: ['YES'],
      },
      secrets: {
        slackSecretName: 'example/slack/webhook',
      },
    });
    const template = Template.fromStack(stack);

    it('wires both auto-start rules to the durable function alias', () => {
      expectDurableWiring(template);
    });

    it('should have event rules disabled', () => {
      const rules = template.findResources('AWS::Events::Rule');
      const ruleProps = Object.values(rules).map((r: { Properties?: { State?: string } }) => r.Properties?.State);
      expect(ruleProps.every((s: string | undefined) => s === 'DISABLED')).toBe(true);
    });

    it('should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });
  });

  describe('Without Slack secret', () => {
    const app = new App();
    const stack = new RDSDatabaseAutoStartPreventStack(app, 'RDSDatabaseAutoStartPreventStack', {
      secrets: {},
      targetResource: {
        tagKey: 'AutoRunningStop',
        tagValues: ['YES'],
      },
    });
    const template = Template.fromStack(stack);

    it('wires both auto-start rules to the durable function alias', () => {
      expectDurableWiring(template);
    });

    it('omits the Slack secret environment variable and read permission', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const variables = Object.values(functions).map((resource) => {
        const properties = resource as {
          Properties?: { Environment?: { Variables?: Record<string, string> } };
        };
        return properties.Properties?.Environment?.Variables ?? {};
      });
      expect(variables.every((env) => !('SLACK_SECRET_NAME' in env))).toBe(true);
      expect(JSON.stringify(template.toJSON())).not.toContain('secretsmanager:GetSecretValue');
    });
  });

  describe('Failure detection', () => {
    const baseProps = {
      secrets: {},
      targetResource: {
        tagKey: 'AutoRunningStop',
        tagValues: ['YES'],
      },
    } satisfies RDSDatabaseAutoStartPreventStackProps;

    it.each([
      ['omitted', undefined],
      ['disabled', { enabled: false }],
    ])('creates no alarms when %s', (_name, failureDetection) => {
      const stack = new RDSDatabaseAutoStartPreventStack(new App(), 'RDSDatabaseAutoStartPreventStack', {
        ...baseProps,
        failureDetection,
      });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
      template.resourceCountIs('AWS::Logs::MetricFilter', 0);
    });

    it('creates Lambda and log-based alarms without actions when no topic is set', () => {
      const stack = new RDSDatabaseAutoStartPreventStack(new App(), 'RDSDatabaseAutoStartPreventStack', {
        ...baseProps,
        failureDetection: { enabled: true },
      });
      const template = Template.fromStack(stack);
      const [logGroupLogicalId] = Object.keys(template.findResources('AWS::Logs::LogGroup'));

      template.resourceCountIs('AWS::SNS::Topic', 0);
      template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
      template.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AWS/Lambda', MetricName: 'Errors' });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AWS/Lambda', MetricName: 'Throttles' });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'RDSDatabaseAutoStartPreventer',
        MetricName: 'AutoStartPreventFailed',
      });
      template.resourceCountIs('AWS::Logs::MetricFilter', 1);
      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        LogGroupName: { Ref: logGroupLogicalId },
        FilterPattern: '"AutoStartPreventFailed"',
        MetricTransformations: [Match.objectLike({
          MetricNamespace: 'RDSDatabaseAutoStartPreventer',
          MetricName: 'AutoStartPreventFailed',
        })],
      });
      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
      expect(alarms.every((alarm) => alarm.Properties.AlarmActions === undefined)).toBe(true);
    });

    it('notifies the given topic from every alarm', () => {
      const stack = new Stack(new App(), 'TestStack');
      const alarmTopic = new Topic(stack, 'AlarmTopic');
      new RDSDatabaseAutoStartPreventer(stack, 'RDSDatabaseAutoStartPreventer', {
        ...baseProps,
        failureDetection: { enabled: true, alarmTopic },
      });
      const template = Template.fromStack(stack);
      const [topicLogicalId] = Object.keys(template.findResources('AWS::SNS::Topic'));

      template.resourceCountIs('AWS::SNS::Topic', 1);
      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
      expect(alarms).toHaveLength(3);
      for (const alarm of alarms) {
        expect(alarm.Properties.AlarmActions).toEqual([{ Ref: topicLogicalId }]);
      }
    });
  });

  describe('Invalid props', () => {
    const validProps = {
      secrets: {
        slackSecretName: 'example/slack/webhook',
      },
      targetResource: {
        tagKey: 'AutoRunningStop',
        tagValues: ['YES'],
      },
    } satisfies RDSDatabaseAutoStartPreventStackProps;

    const createStack = (props: RDSDatabaseAutoStartPreventStackProps): RDSDatabaseAutoStartPreventStack =>
      new RDSDatabaseAutoStartPreventStack(new App(), 'RDSDatabaseAutoStartPreventStack', props);

    it.each([
      ['empty tagKey', { ...validProps, targetResource: { tagKey: '', tagValues: ['YES'] } }, 'targetResource.tagKey'],
      ['whitespace tagKey', { ...validProps, targetResource: { tagKey: '   ', tagValues: ['YES'] } }, 'targetResource.tagKey'],
      ['empty tagValues', { ...validProps, targetResource: { tagKey: 'AutoRunningStop', tagValues: [] } }, 'targetResource.tagValues'],
      ['blank tag value', { ...validProps, targetResource: { tagKey: 'AutoRunningStop', tagValues: [''] } }, 'targetResource.tagValues'],
      ['whitespace tag value', { ...validProps, targetResource: { tagKey: 'AutoRunningStop', tagValues: ['YES', '  '] } }, 'targetResource.tagValues'],
      ['empty slackSecretName', { ...validProps, secrets: { slackSecretName: '' } }, 'secrets.slackSecretName'],
      ['whitespace slackSecretName', { ...validProps, secrets: { slackSecretName: '   ' } }, 'secrets.slackSecretName'],
    ])('rejects %s', (_name, props, message) => {
      expect(() => createStack(props)).toThrow(message);
    });

    it('skips emptiness checks for unresolved tokens', () => {
      const unresolved = Lazy.string({ produce: () => 'resolved-later' });
      expect(Token.isUnresolved(unresolved)).toBe(true);
      expect(() => createStack({
        secrets: { slackSecretName: unresolved },
        targetResource: {
          tagKey: unresolved,
          tagValues: [unresolved],
        },
      })).not.toThrow();
    });
  });
});
