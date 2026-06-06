import { awscdk, javascript, github } from 'projen';
const project = new awscdk.AwsCdkConstructLibrary({
  author: 'yicr',
  authorAddress: 'yicr@users.noreply.github.com',
  cdkVersion: '2.232.0',
  defaultReleaseBranch: 'main',
  jsiiVersion: '~5.9.0',
  typescriptVersion: '5.9.x',
  name: 'rds-database-auto-start-preventer',
  packageManager: javascript.NodePackageManager.YARN_CLASSIC,
  projenrcTs: true,
  repositoryUrl: 'https://github.com/gammarers-aws-cdk-constructs/rds-database-auto-start-preventer.git',
  devDeps: [
    '@aws/durable-execution-sdk-js@^1.1.7',
    '@aws-sdk/client-lambda@^3.1063.0',
    '@aws-sdk/client-rds@^3.1063.0',
    '@aws-sdk/client-resource-groups-tagging-api@^3.1063.0',
    '@slack/web-api@^6.13.0',
    '@types/aws-lambda@^8.10.162',
    'aws-lambda-secret-fetcher@^0.5.1',
    'aws-sdk-client-mock@^4.1.0',
    'aws-sdk-client-mock-jest@^4.1.0',
  ],
  releaseToNpm: false,
  npmTrustedPublishing: false,
  npmAccess: javascript.NpmAccess.PUBLIC,
  mergify: true,
  minNodeVersion: '20.0.0',
  workflowNodeVersion: '24.x',
  depsUpgradeOptions: {
    workflowOptions: {
      labels: ['auto-approve', 'auto-merge'],
      schedule: javascript.UpgradeDependenciesSchedule.WEEKLY,
    },
  },
  githubOptions: {
    projenCredentials: github.GithubCredentials.fromApp({
      permissions: {
        pullRequests: github.workflows.AppPermission.WRITE,
        contents: github.workflows.AppPermission.WRITE,
        workflows: github.workflows.AppPermission.WRITE,
      },
    }),
  },
  autoApproveOptions: {
    allowedUsernames: [
      'gammarers-projen-upgrade-bot[bot]',
      'yicr',
    ],
  },
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