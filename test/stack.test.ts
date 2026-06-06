import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RDSDatabaseAutoStartPreventStack } from '../src';

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
        Timeout: 900,
        MemorySize: 512,
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            SLACK_SECRET_NAME: 'example/slack/webhook',
          }),
        }),
      }));
    });

    it('should have event rule count', () => {
      template.resourceCountIs('AWS::Events::Rule', 2);
    });

    it('should have event rules enabled', () => {
      const rules = template.findResources('AWS::Events::Rule');
      const ruleProps = Object.values(rules).map((r: { Properties?: { State?: string } }) => r.Properties?.State);
      expect(ruleProps).toContain('ENABLED');
      expect(ruleProps.every((s: string | undefined) => s === 'ENABLED')).toBe(true);
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

    it('should have event rules disabled', () => {
      const rules = template.findResources('AWS::Events::Rule');
      const ruleProps = Object.values(rules).map((r: { Properties?: { State?: string } }) => r.Properties?.State);
      expect(ruleProps.every((s: string | undefined) => s === 'DISABLED')).toBe(true);
    });

    it('should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });
  });
});
