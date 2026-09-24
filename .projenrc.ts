import { ProjenCdkConstructLibrary } from '@gammarers/projen-projects';
import { awscdk } from 'projen';
const project = new ProjenCdkConstructLibrary({
  cdkVersion: '2.232.0',
  name: 'rds-database-auto-start-preventer',
  repository: 'https://github.com/gammarers-aws-cdk-constructs/rds-database-auto-start-preventer.git',
  description: 'CDK stack that stops RDS DB instances and clusters after they are auto-started by AWS (RDS-EVENT-0154 / RDS-EVENT-0153). It uses EventBridge rules and a Durable Lambda to detect auto-start events, optionally filter by tags, stop the resource if it matches, and post a notification to Slack.',
  keywords: [
    'cdk',
    'aws',
    'aws-cdk',
    'rds',
  ],
  devDeps: [
    '@gammarers/projen-projects@^0.3.1',
    '@aws/durable-execution-sdk-js@^1.1.7',
    '@aws-sdk/client-lambda@^3.1063.0',
    '@aws-sdk/client-rds@^3.1063.0',
    '@aws-sdk/client-resource-groups-tagging-api@^3.1063.0',
    '@slack/web-api@^6.13.0',
    '@types/aws-lambda@^8.10.162',
    'aws-lambda-secret-fetcher@^0.8.0',
    'aws-sdk-client-mock@^4.1.0',
    'aws-sdk-client-mock-jest@^4.1.0',
    'strict-env-resolver@^0.7.1',
  ],
  releaseToNpm: true,
  npmTrustedPublishing: true,
  jestOptions: {
    extraCliOptions: ['--silent'],
  },
  tsconfigDev: {
    compilerOptions: {
      strict: true,
    },
  },
  lambdaOptions: {
    // target node.js runtime
    runtime: awscdk.LambdaRuntime.NODEJS_24_X,
    bundlingOptions: {
      // list of node modules to exclude from the bundle
      externals: ['@aws-sdk/*'],
      sourcemap: true,
    },
  },
});
project.addPackageIgnore('/.devcontainer');
project.synth();