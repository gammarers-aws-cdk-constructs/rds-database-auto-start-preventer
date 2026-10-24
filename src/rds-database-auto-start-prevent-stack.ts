import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  RDSDatabaseAutoStartPreventer,
  RDSDatabaseAutoStartPreventerProps,
} from './rds-database-auto-start-preventer';

/**
 * Props for the RDS database auto start prevent CDK stack.
 */
export interface RDSDatabaseAutoStartPreventStackProps extends RDSDatabaseAutoStartPreventerProps, StackProps {}

/**
 * CDK stack that deploys {@link RDSDatabaseAutoStartPreventer}.
 */
export class RDSDatabaseAutoStartPreventStack extends Stack {
  /**
   * Creates the stack and the RDSDatabaseAutoStartPreventer construct.
   *
   * @param scope - Parent construct.
   * @param id - Stack id.
   * @param props - Stack props (target resource, enable rule, secrets).
   */
  constructor(scope: Construct, id: string, props: RDSDatabaseAutoStartPreventStackProps) {
    super(scope, id, props);

    new RDSDatabaseAutoStartPreventer(this, 'RDSDatabaseAutoStartPreventer', {
      targetResource: props.targetResource,
      enableRule: props.enableRule,
      secrets: props.secrets,
    });
  }
}
