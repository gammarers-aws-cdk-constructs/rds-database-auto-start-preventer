import {
  buildSlackStopNotification,
  buildStoppedResult,
  decideAfterTagMatch,
  isAutoStartPreventInput,
  isDbClusterAutoStart,
  isDbInstanceAutoStart,
  isSlackSecret,
  isTransitionalStatus,
  matchTag,
  normalizeInput,
  parseRdsSourceArn,
  RdsAutoStartDetail,
  tagMismatchNoOp,
  TRANSITIONAL_STATUSES,
  waitStrategyUntilStable,
  waitStrategyUntilStopped,
} from '../src/funcs/auto-start-prevent.predicates';

describe('auto-start-prevent.predicates', () => {
  describe('isSlackSecret', () => {
    it.each([
      [{ token: 'xoxb-1', channel: 'C123' }, true],
      [{ token: '', channel: 'C123' }, false],
      [{ token: 'xoxb-1', channel: '' }, false],
      [{ token: 'xoxb-1' }, false],
      [{ channel: 'C123' }, false],
      ['{"token":"xoxb-1","channel":"C123"}', false],
      [null, false],
      [undefined, false],
      [42, false],
    ])('returns %s for %j', (value, expected) => {
      expect(isSlackSecret(value)).toBe(expected);
    });
  });

  describe('normalizeInput / isAutoStartPreventInput', () => {
    const validInput = {
      event: {
        'detail-type': 'RDS DB Instance Event' as const,
        'source': 'aws.rds' as const,
        'detail': {
          EventID: 'RDS-EVENT-0154' as const,
          SourceType: 'DB_INSTANCE' as const,
          SourceArn: 'arn:aws:rds:ap-northeast-1:123456789012:db:demo',
          SourceIdentifier: 'demo',
        },
      },
      params: { tagKey: 'AutoStartPrevent', tagValues: ['YES'] },
    };

    it('accepts { event, params }', () => {
      expect(isAutoStartPreventInput(validInput)).toBe(true);
      expect(normalizeInput(validInput)).toEqual(validInput);
    });

    it.each([
      [null],
      [undefined],
      ['raw'],
      [{ event: validInput.event }],
      [{ params: validInput.params }],
      [{ event: null, params: validInput.params }],
      [{ event: validInput.event, params: null }],
      [validInput.event],
    ])('rejects %j', (input) => {
      expect(isAutoStartPreventInput(input)).toBe(false);
      expect(() => normalizeInput(input)).toThrow('Invalid input: expected { event, params }.');
    });
  });

  describe('matchTag', () => {
    const params = { tagKey: 'AutoStartPrevent', tagValues: ['YES', 'TRUE'] };

    it.each([
      [[{ Key: 'AutoStartPrevent', Value: 'YES' }], true],
      [[{ Key: 'AutoStartPrevent', Value: 'TRUE' }], true],
      [[{ Key: 'AutoStartPrevent', Value: 'NO' }], false],
      [[{ Key: 'Other', Value: 'YES' }], false],
      [[{ Key: 'AutoStartPrevent' }], false],
      [[], false],
      [undefined, false],
    ])('matchTag(%j) => %s', (tags, expected) => {
      expect(matchTag(params, tags)).toBe(expected);
    });
  });

  describe('isDbInstanceAutoStart / isDbClusterAutoStart', () => {
    const instanceDetail: RdsAutoStartDetail = {
      EventID: 'RDS-EVENT-0154',
      SourceType: 'DB_INSTANCE',
      SourceArn: 'arn:aws:rds:us-east-1:111122223333:db:i1',
      SourceIdentifier: 'i1',
    };
    const clusterDetail: RdsAutoStartDetail = {
      EventID: 'RDS-EVENT-0153',
      SourceType: 'CLUSTER',
      SourceArn: 'arn:aws:rds:us-east-1:111122223333:cluster:c1',
      SourceIdentifier: 'c1',
    };

    it('detects supported instance auto-start', () => {
      expect(isDbInstanceAutoStart('RDS DB Instance Event', instanceDetail)).toBe(true);
      expect(isDbClusterAutoStart('RDS DB Instance Event', instanceDetail)).toBe(false);
    });

    it('detects supported cluster auto-start', () => {
      expect(isDbClusterAutoStart('RDS DB Cluster Event', clusterDetail)).toBe(true);
      expect(isDbInstanceAutoStart('RDS DB Cluster Event', clusterDetail)).toBe(false);
    });

    it('rejects mismatched event id / source type', () => {
      expect(
        isDbInstanceAutoStart('RDS DB Instance Event', {
          ...instanceDetail,
          EventID: 'RDS-EVENT-0153',
        }),
      ).toBe(false);
      expect(
        isDbClusterAutoStart('RDS DB Cluster Event', {
          ...clusterDetail,
          SourceType: 'DB_INSTANCE',
        }),
      ).toBe(false);
    });
  });

  describe('isTransitionalStatus / waitStrategyUntilStable', () => {
    it.each([...TRANSITIONAL_STATUSES])('treats %s as transitional', (status) => {
      expect(isTransitionalStatus(status)).toBe(true);
      expect(waitStrategyUntilStable({ status, identifier: 'db' })).toEqual({
        shouldContinue: true,
        delay: { minutes: 5 },
      });
    });

    it.each(['available', 'stopped', 'storage-optimization', 'unknown'])(
      'stops waiting for %s',
      (status) => {
        expect(isTransitionalStatus(status)).toBe(false);
        expect(waitStrategyUntilStable({ status, identifier: 'db' })).toEqual({
          shouldContinue: false,
        });
      },
    );
  });

  describe('waitStrategyUntilStopped', () => {
    it('stops when status is stopped', () => {
      expect(waitStrategyUntilStopped({ status: 'stopped', identifier: 'db' })).toEqual({
        shouldContinue: false,
      });
    });

    it.each(['stopping', 'modifying', 'starting'])('continues while %s', (status) => {
      expect(waitStrategyUntilStopped({ status, identifier: 'db' })).toEqual({
        shouldContinue: true,
        delay: { minutes: 5 },
      });
    });

    it.each(['available', 'failed', 'unknown'])('throws on unexpected %s', (status) => {
      expect(() => waitStrategyUntilStopped({ status, identifier: 'db' })).toThrow(
        `Unexpected status while waiting for stop: ${status}`,
      );
    });
  });

  describe('decideAfterTagMatch', () => {
    it('requests stop when available', () => {
      expect(decideAfterTagMatch('available')).toEqual({ kind: 'stop' });
    });

    it('returns already-stopped no-op', () => {
      expect(decideAfterTagMatch('stopped')).toEqual({
        kind: 'no-op',
        result: {
          action: 'no-op',
          reason: 'already stopped',
          status: 'stopped',
        },
      });
    });

    it.each(['available-read-replica', 'storage-full', 'unknown'])(
      'errors for unexpected %s',
      (status) => {
        expect(decideAfterTagMatch(status)).toEqual({
          kind: 'error',
          message: `DB status is not stopped after processing: ${status}`,
        });
      },
    );
  });

  describe('tagMismatchNoOp / buildStoppedResult / parseRdsSourceArn', () => {
    it('builds tag mismatch no-op', () => {
      expect(tagMismatchNoOp('available')).toEqual({
        action: 'no-op',
        reason: 'tag not matched or not found',
        status: 'available',
      });
    });

    it('parses region and account from SourceArn', () => {
      expect(
        parseRdsSourceArn('arn:aws:rds:ap-northeast-1:123456789012:db:demo'),
      ).toEqual({
        region: 'ap-northeast-1',
        account: '123456789012',
      });
    });

    it('returns empty segments for short ARN', () => {
      expect(parseRdsSourceArn('arn:aws:rds')).toEqual({ region: '', account: '' });
    });

    it('builds stopped result', () => {
      expect(
        buildStoppedResult({
          finalStatus: 'stopped',
          account: '123456789012',
          region: 'us-east-1',
          identifier: 'demo',
        }),
      ).toEqual({
        action: 'stopped',
        finalStatus: 'stopped',
        account: '123456789012',
        region: 'us-east-1',
        identifier: 'demo',
      });
    });
  });

  describe('buildSlackStopNotification', () => {
    it('includes channel, pretext, and identity fields', () => {
      const payload = buildSlackStopNotification({
        channel: 'C01234',
        sourceType: 'DB_INSTANCE',
        sourceIdentifier: 'demo-db',
        account: '123456789012',
        region: 'ap-northeast-1',
      });

      expect(payload.channel).toBe('C01234');
      expect(payload.attachments).toHaveLength(1);
      expect(payload.attachments[0].pretext).toContain('DB_INSTANCE');
      expect(payload.attachments[0].pretext).toContain('demo-db');
      expect(payload.attachments[0].fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: 'Account', value: '123456789012' }),
          expect.objectContaining({ title: 'Region', value: 'ap-northeast-1' }),
          expect.objectContaining({ title: 'Type', value: 'DB_INSTANCE' }),
          expect.objectContaining({ title: 'Identifier', value: 'demo-db' }),
        ]),
      );
    });
  });
});
