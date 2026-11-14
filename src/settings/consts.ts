/**
 * Values shared by the construct (EventBridge rules) and the Lambda handler (event checks).
 */

/** EventBridge source for RDS events. */
export const RDS_EVENT_SOURCE = 'aws.rds';

/** RDS DB instance auto-start event (RDS-EVENT-0154). */
export const DB_INSTANCE_AUTO_START_EVENT = {
  detailType: 'RDS DB Instance Event',
  eventId: 'RDS-EVENT-0154',
  sourceType: 'DB_INSTANCE',
} as const;

/** RDS DB cluster auto-start event (RDS-EVENT-0153). */
export const DB_CLUSTER_AUTO_START_EVENT = {
  detailType: 'RDS DB Cluster Event',
  eventId: 'RDS-EVENT-0153',
  sourceType: 'CLUSTER',
} as const;
