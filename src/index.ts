/**
 * RDS Database Auto Start Preventer — CDK construct library.
 *
 * Stops RDS DB instances and clusters after AWS auto-start events. The handler
 * filters by tags and, when a Slack secret name is set, posts to Slack after a
 * successful stop.
 *
 * @module rds-database-auto-start-preventer
 */
export * from './constructs/rds-database-auto-start-preventer';
export * from './stacks/rds-database-auto-start-prevent-stack';
