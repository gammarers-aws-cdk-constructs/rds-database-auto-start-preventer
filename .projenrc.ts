import { ProjenCdkConstructLibrary } from '@gammarers/projen-projects';
const project = new ProjenCdkConstructLibrary({
  cdkVersion: '2.232.0',
  name: 'rds-database-auto-start-preventer',
  repositoryUrl: 'https://github.com/gammarers-aws-cdk-constructs/rds-database-auto-start-preventer.git',
  description: 'CDK construct library that stops RDS DB instances and clusters after they are auto-started by AWS (RDS-EVENT-0154 / RDS-EVENT-0153), using EventBridge and a Durable Lambda to filter by tags in the handler, stop matching available resources, and post to Slack only after a successful stop when a Slack secret name is set.',
  keywords: [
    'cdk',
    'aws',
    'aws-cdk',
    'rds',
  ],
  devDeps: [
    '@gammarers/projen-projects@^0.5.10',
    '@aws/durable-execution-sdk-js@^1.1.7',
    '@aws-sdk/client-rds@^3.1063.0',
    '@slack/web-api@^6.13.0',
    '@types/aws-lambda@^8.10.162',
    'aws-lambda-secret-fetcher@^0.8.0',
    'aws-sdk-client-mock@^4.1.0',
    'aws-sdk-client-mock-jest@^4.1.0',
    'strict-env-resolver@^0.7.1',
  ],
  releaseToNpm: true,
  npmTrustedPublishing: true,
});
project.synth();