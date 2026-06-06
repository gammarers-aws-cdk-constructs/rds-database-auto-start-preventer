import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { AutoStartPreventFunction } from '../funcs/auto-start-prevent-function';

/**
 * Tag-based criteria to select which RDS instances or clusters are subject to auto-start prevention.
 */
export interface TargetResource {
  /** Tag key to match (e.g. "Environment", "AutoStartPrevent"). */
  readonly tagKey: string;
  /** Tag values that indicate the resource should be protected (e.g. ["production"]). */
  readonly tagValues: string[];
}

/**
 * External secrets required for notifications (e.g. Slack).
 */
export interface Secrets {
  /** Name of the Secrets Manager secret containing Slack token and channel. */
  readonly slackSecretName: string;
}

/**
 * Props for the RDS database auto-start preventer construct.
 */
export interface RDSDatabaseAutoStartPreventerProps {
  /** Tag-based target resource criteria for RDS instances/clusters to protect. */
  readonly targetResource: TargetResource;
  /** Whether the EventBridge rules are enabled. Defaults to true if omitted. */
  readonly enableRule?: boolean;
  /** Secrets used for notifications (e.g. Slack). */
  readonly secrets: Secrets;
}

/**
 * Construct that deploys EventBridge rules and a Durable Lambda to prevent RDS DB instances
 * and clusters from staying running after an auto-start event (RDS-EVENT-0154 / RDS-EVENT-0153).
 */
export class RDSDatabaseAutoStartPreventer extends Construct {

  /**
   * Creates the construct: Lambda (with Params and Secrets), EventBridge rules, and IAM.
   *
   * @param scope - Parent construct.
   * @param id - Construct id.
   * @param props - Target resource (tag key/values), enable rule flag, and secrets.
   */
  constructor(scope: Construct, id: string, props: RDSDatabaseAutoStartPreventerProps) {
    super(scope, id);

    const slackSecret = Secret.fromSecretNameV2(this, 'SlackSecret', props.secrets.slackSecretName);

    // Durable Functions-based Running Scheduler (previous Step Functions logic implemented in Lambda).
    // Durable Execution requires Node.js 22+.
    const autoStartPreventFunction = new AutoStartPreventFunction(this, 'AutoStartPreventFunction', {
      description: 'A function to prevent the RDS Database or Cluster from starting automatically.',
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(15),
      memorySize: 512,
      retryAttempts: 2,
      durableConfig: {
        executionTimeout: Duration.hours(2),
        retentionPeriod: Duration.days(1),
      },
      environment: {
        SLACK_SECRET_NAME: slackSecret.secretName,
      },
      paramsAndSecrets: lambda.ParamsAndSecretsLayerVersion.fromVersion(lambda.ParamsAndSecretsVersions.V1_0_103, {
        cacheSize: 500,
        logLevel: lambda.ParamsAndSecretsLogLevel.INFO,
      }),
      role: new iam.Role(this, 'AutoStartPreventFunctionRole', {
        description: 'A role to control the RDS Database or Cluster.',
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
        ],
      }),
      logGroup: new logs.LogGroup(this, 'AutoStartPreventFunctionLogGroup', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.INFO,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
    });
    autoStartPreventFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'GetResources',
      effect: iam.Effect.ALLOW,
      actions: [
        'tag:GetResources',
      ],
      resources: ['*'],
    }));
    // Grant read access to the RDS API
    autoStartPreventFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RdsAutoStartControl',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds:DescribeDBInstances',
        'rds:DescribeDBClusters',
        'rds:StopDBInstance',
        'rds:StopDBCluster',
      ],
      resources: ['*'],
    }));
    // Grant read access to the Slack secret
    slackSecret.grantRead(autoStartPreventFunction);

    // See: https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started-iac.html
    const autoStartPreventFunctionAlias = autoStartPreventFunction.addAlias('live');

    const enableRule: boolean = (() => {
      return props.enableRule === undefined || props.enableRule;
    })();

    // Convert the rule input to pass { event, params } to the Lambda (tag conditions are injected by the Rule).
    const lambdaInput = events.RuleTargetInput.fromObject({
      event: events.EventField.fromPath('$'),
      params: {
        tagKey: props.targetResource.tagKey,
        tagValues: props.targetResource.tagValues,
      },
    });

    // 👇 EventBridge by RDS DB Instance auto start event
    new events.Rule(this, 'DBInstanceEvent', {
      description: 'rds db instance auto start event catch rule.',
      enabled: enableRule,
      eventPattern: {
        source: ['aws.rds'],
        detailType: ['RDS DB Instance Event'],
        detail: {
          EventID: ['RDS-EVENT-0154'],
        },
      },
      targets: [
        new targets.LambdaFunction(autoStartPreventFunctionAlias, {
          retryAttempts: 2,
          event: lambdaInput,
        }),
      ],
    });

    // 👇 EventBridge by RDS DB Cluster auto start event
    new events.Rule(this, 'DBClusterEvent', {
      description: 'db cluster auto start event catch rule',
      enabled: enableRule,
      eventPattern: {
        source: ['aws.rds'],
        detailType: ['RDS DB Cluster Event'],
        detail: {
          EventID: ['RDS-EVENT-0153'],
        },
      },
      targets: [
        new targets.LambdaFunction(autoStartPreventFunctionAlias, {
          retryAttempts: 2,
          event: lambdaInput,
        }),
      ],
    });
  }
}
