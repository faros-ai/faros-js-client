import fs from 'fs';
import {buildSchema} from 'graphql';
import path from 'path';

import {FarosGraphSchema} from '../src/schema';
import {SCHEMA_DIR} from './helpers';

describe('schema', () => {
  const schema = new FarosGraphSchema(
    buildSchema(
      fs.readFileSync(path.join(SCHEMA_DIR, 'timestamp-schema.gql'), 'utf8')
    )
  );

  test('ignore non-timestamp field', () => {
    const record = {uid: 'abc'};
    expect(schema.fixTimestampFields(record, 'ims_Incident')).toEqual(record);
  });

  test('fix timestamp field', () => {
    const record = {uid: 'abc', createdAt: new Date(123)};
    const json1 = {...record, createdAt: 123};
    const json2 = {...record, createdAt: '123'};
    const json3 = {...record, createdAt: record.createdAt.toISOString()};
    expect(schema.fixTimestampFields(json1, 'ims_Incident').createdAt).toEqual(
      new Date(123)
    );
    expect(schema.fixTimestampFields(json2, 'ims_Incident').createdAt).toEqual(
      new Date(123)
    );
    expect(schema.fixTimestampFields(json3, 'ims_Incident').createdAt).toEqual(
      new Date(123)
    );
  });

  test('fix non-null timestamp field', () => {
    const record = {uid: 'abc', createdAt: new Date(123)};
    const json = {...record, createdAt: 123};
    expect(schema.fixTimestampFields(json, 'ims_Incident').createdAt).toEqual(
      new Date(123)
    );
  });

  test('fix jsonb - array', () => {
    const record = {
      uid: 'abc', status: [
        {
          'foo': {
            'category': 'Todo',
            'detail': 'To Do',
            'fixAt': 1633751867746,
            'skippedAt': 'not-interesting'
          },
          'changedAt': 1629751867746,
          'ignoredAt': 'blah',
        },
        {
          'bar': {
            'category': 'Todo',
            'fixAt': 1645751867746,
            'skippedAt': 'not-interesting',
            'detail': 'Selected for Development',
          },
          'changedAt': 1629832560991,
          'skipAt': 'nothing'
        },
      ],
    };
    expect(schema.fixTimestampFields(record, 'ims_Incident'))
      .toMatchSnapshot();
  });

  test('fix jsonb - object', () => {
    const record = {
      uid: 'abc',
      status: {
        'foo': {
          'category': 'Todo',
          'detail': 'To Do',
          'brokenAt': 1644751867746,
          'ackedAt': 'ignore'
        },
        'changedAt': 1629751867746,
        'submittedAt': 'foo'
      },
    };
    expect(schema.fixTimestampFields(record, 'ims_Incident'))
      .toMatchSnapshot();
  });

  test('fix nested timestamp field', () => {
    const record = {uid: 'abc', timestampObj: {createdAt: new Date(123)}};
    const json = {uid: 'abc', timestampObj: {createdAt: 123}};
    expect(schema.fixTimestampFields(json, 'ims_Incident')).toEqual(record);
  });

  test('fix array of timestamp fields', () => {
    const record = {
      uid: 'abc',
      array: [
        {createdAt: new Date(123)},
        {createdAt: new Date(456)},
        {createdAt: new Date(789)},
      ],
    };
    const json = {
      uid: 'abc',
      array: [
        {createdAt: 123},
        {createdAt: '456'},
        {createdAt: new Date(789).toISOString()},
      ],
    };
    expect(schema.fixTimestampFields(json, 'ims_Incident')).toEqual(record);
  });

  test('fix timestamptz field', () => {
    const date = new Date(123);
    const record = {uid: 'abc', createdAt: date};
    const json1 = {...record, createdAt: 123};
    const json2 = {...record, createdAt: '123'};
    const json3 = {...record, createdAt: date.toISOString()};
    expect(schema.fixTimestampFields(json1, 'vcs_Commit').createdAt).toEqual(
      date.toISOString()
    );
    expect(schema.fixTimestampFields(json2, 'vcs_Commit').createdAt).toEqual(
      date.toISOString()
    );
    expect(schema.fixTimestampFields(json3, 'vcs_Commit').createdAt).toEqual(
      date.toISOString()
    );
  });

  test('invalid date in timestamptz field', () => {
    expect(() =>
      schema.fixTimestampFields({uid: 'abc', createdAt: 'bad'}, 'vcs_Commit')
    ).toThrowError('Invalid date: bad');

    expect(() =>
      schema.fixTimestampFields({uid: 'abc', createdAt: 10 ** 20}, 'vcs_Commit')
    ).toThrowError();
  });

  test('fix timestamp field in operation record', () => {
    const record = {uid: 'abc', createdAt: 123};
    expect(
      schema.fixTimestampFields(record, 'ims_Incident__Upsert').createdAt
    ).toEqual(new Date(123));

    expect(
      schema.fixTimestampFields({where: record}, 'ims_Incident__Deletion').where
        .createdAt
    ).toEqual(new Date(123));

    expect(
      schema.fixTimestampFields({where: record}, 'ims_Incident__Update').where
        .createdAt
    ).toEqual(new Date(123));

    expect(
      schema.fixTimestampFields({patch: record}, 'ims_Incident__Update').patch
        .createdAt
    ).toEqual(new Date(123));

    expect(
      schema.fixTimestampFields({mask: record}, 'ims_Incident__Update').mask
        .createdAt
    ).toEqual(new Date(123));
  });
});
