import {Duration} from 'luxon';
import {VError} from 'verror';

import {parsePrimaryKeys} from '../src/graphql/schema';
import * as sut from '../src/utils';

describe('utils', () => {
  test('trim trailing slashes from url', () => {
    const f = sut.Utils.urlWithoutTrailingSlashes;
    expect(() => f('abc')).toThrow('Invalid URL');
    expect(f('https://example.com')).toEqual('https://example.com');
    expect(f('https://example.com/')).toEqual('https://example.com');
    expect(f('https://example.com//')).toEqual('https://example.com');
    expect(f('https://example.com///')).toEqual('https://example.com');
  });

  test('parse date', () => {
    expect(sut.Utils.toDate('')).toBeUndefined();
    expect(sut.Utils.toDate(0)).toEqual(new Date('1970-01-01T00:00:00.000Z'));
    expect(sut.Utils.toDate('2021-06-04T02:24:57.000Z')?.getTime()).toEqual(
      1622773497000
    );
    expect(sut.Utils.toDate(1622773497000)).toEqual(
      new Date('2021-06-04T02:24:57.000Z')
    );
  });

  test('parse duration', () => {
    expect(sut.Utils.toDuration(1234))
      .toEqual(Duration.fromObject({milliseconds: 1234}));
    expect(sut.Utils.toDuration('1234'))
      .toEqual(Duration.fromObject({milliseconds: 1234}));
    expect(sut.Utils.toDuration('1 second'))
      .toEqual(Duration.fromObject({seconds: 1}));
    expect(sut.Utils.toDuration('15 seconds'))
      .toEqual(Duration.fromObject({seconds: 15}));
    expect(sut.Utils.toDuration('1 minute'))
      .toEqual(Duration.fromObject({minutes: 1}));
    expect(sut.Utils.toDuration('123 minutes'))
      .toEqual(Duration.fromObject({minutes: 123}));
    expect(sut.Utils.toDuration('1 hour'))
      .toEqual(Duration.fromObject({hours: 1}));
    expect(sut.Utils.toDuration('24 hours'))
      .toEqual(Duration.fromObject({hours: 24}));
    expect(sut.Utils.toDuration('1 day'))
      .toEqual(Duration.fromObject({days: 1}));
    expect(sut.Utils.toDuration('2 days'))
      .toEqual(Duration.fromObject({days: 2}));
  });

  test('throw on invalid duration', () => {
    expect(() => sut.Utils.toDuration('5 zorklings'))
      .toThrowError(/Invalid unit/);
  });

  test('parse number', () => {
    expect(() => sut.Utils.parseInteger('')).toThrow(VError);
    expect(() => sut.Utils.parseInteger('123x')).toThrow(VError);
    expect(sut.Utils.parseInteger('1622773497000')).toEqual(1622773497000);
  });
  test('parse positive number', () => {
    expect(sut.Utils.parseIntegerPositive('423')).toEqual(423);
    expect(() => sut.Utils.parseIntegerPositive('0')).toThrow(VError);
  });

  test('parse number with default', () => {
    expect(() => sut.Utils.parseIntegerWithDefault({}, 123)).toThrow(VError);
    expect(() => sut.Utils.parseIntegerWithDefault('-1', 1, true)).toThrow(
      VError
    );
    expect(sut.Utils.parseIntegerWithDefault('', 1622)).toEqual(1622);
    expect(sut.Utils.parseIntegerWithDefault(876, 1622)).toEqual(876);
    expect(sut.Utils.parseIntegerWithDefault('631', 1622)).toEqual(631);
    expect(sut.Utils.parseIntegerWithDefault('3', 2, true)).toEqual(3);
  });

  test('parse float', () => {
    expect(() => sut.Utils.parseFloatFixedPoint('')).toThrow(VError);
    expect(() => sut.Utils.parseFloatFixedPoint('12.3ss0x')).toThrow(VError);
    expect(sut.Utils.parseFloatFixedPoint('16.22773497000')).toEqual(
      16.22773497
    );
    expect(sut.Utils.parseFloatFixedPoint('109.277', 1)).toEqual(109.3);
    expect(sut.Utils.parseFloatFixedPoint('109.277', 0)).toEqual(109);
  });

  test('parse positive float', () => {
    expect(sut.Utils.parseFloatFixedPointPositive('4.26')).toEqual(4.26);
    expect(() => sut.Utils.parseFloatFixedPointPositive('0.00')).toThrow(
      VError
    );
    expect(() => sut.Utils.parseFloatFixedPointPositive('-109.277')).toThrow(
      VError
    );
  });

  test('parse array to list', () => {
    expect(sut.Utils.toStringList()).toEqual([]);
    expect(sut.Utils.toStringList(['project'])).toEqual(['project']);
    expect(sut.Utils.toStringList('project1,test-project')).toEqual([
      'project1',
      'test-project',
    ]);
  });

  test('trim trailing slashes from url', () => {
    const f = sut.Utils.urlWithoutTrailingSlashes;
    expect(() => f('abc')).toThrow('Invalid URL');
    expect(f('https://example.com')).toEqual('https://example.com');
    expect(f('https://example.com/')).toEqual('https://example.com');
    expect(f('https://example.com//')).toEqual('https://example.com');
    expect(f('https://example.com///')).toEqual('https://example.com');
  });
});

describe('parse primary keys', () => {
  test('multi-tenant columns', () => {
    expect(parsePrimaryKeys(
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, source, uid])',
      true,
      false)
    ).toEqual(['source', 'uid']);
    expect(parsePrimaryKeys(
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, source, uid])',
      true,
      true)
    ).toEqual(['tenantId', 'graphName', 'source', 'uid']);
  });
  test('camel case', () => {
    expect(parsePrimaryKeys(
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, source, uid])',
      false,
      true)
    ).toEqual(['tenant_id', 'graph_name', 'source', 'uid']);
  });
  test('remove PG type info', () => {
    expect(parsePrimaryKeys(
      // eslint-disable-next-line max-len
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, (number)::text, repository_id])',
      true)
    ).toEqual(['number', 'repositoryId']);
    expect(parsePrimaryKeys(
      // eslint-disable-next-line max-len
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, (number)::text, repository_id])',
      false)
    ).toEqual(['number', 'repository_id']);
    expect(parsePrimaryKeys(
      // eslint-disable-next-line max-len
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, (lat)::text, (lon)::text])',
      true)
    ).toEqual(['lat', 'lon']);
  });
});
