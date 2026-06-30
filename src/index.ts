/**
 * RDS Database Auto Start Preventer — CDK construct library.
 *
 * Stops RDS DB instances and clusters after AWS auto-start events, with optional
 * tag-based filtering in the handler and Slack notifications on successful stop.
 *
 * @module rds-database-auto-start-preventer
 */
export * from './constructs/rds-database-auto-start-preventer';
export * from './stacks/rds-database-auto-start-prevent-stack';
