import { App, Lazy, Token } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RDSDatabaseAutoStartPreventStack, RDSDatabaseAutoStartPreventStackProps } from '../src';

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
