import * as sut from '../src/graphql/query-builder';

const ORIGIN = 'test-origin';

describe('query builder', () => {
  const qb = new sut.QueryBuilder(ORIGIN);

  const compute_Application = {
    name: '<application_name>',
    platform: '<application_platform>',
  };
  const cicd_Organization = {
    uid: '<organization_uid>',
    source: '<organization_source>',
  };
  const cicd_Pipeline = {
    uid: '<pipeline_uid>',
    organization: qb.ref({cicd_Organization}),
  };
  const cicd_Build = {
    uid: '<cicd_Build>',
    pipeline: qb.ref({cicd_Pipeline}),
    name: '<build_name>',
  };
  const cicd_Deployment = {
    uid: '<deployment_uid',
    source: '<deployment_source>',
    application: qb.ref({compute_Application}),
    build: qb.ref({cicd_Build}),
    status: {
      category: 'Success',
      detail: '<status_detail>',
    },
  };

  test('creates mutations', () => {
    const mutations = [
      qb.upsert({compute_Application}),
      qb.upsert({cicd_Organization}),
      qb.upsert({cicd_Pipeline}),
      qb.upsert({cicd_Build}),
      qb.upsert({cicd_Deployment}),
    ];
    const queryString = sut.batchMutation(mutations);
    expect(queryString).toMatchSnapshot();
  });

  test('creates mutations with non-model objects', () => {
    const qa_TestCase = {
      uid: '<uid>',
      source: '<source>',
      name: '<name>',
      before: [{description: '<description>', condition: '<condition>'}],
      after: [{description: '<description>', condition: '<condition>'}],
      tags: ['tag1', 'tag2'],
      qa_DeviceInfo: {
        name: 'name',
        os: 'os',
        browser: 'browser',
        isSupported: true,
        size: 10,
      },
    };

    const mutations = [qb.upsert({qa_TestCase})];
    const queryString = sut.batchMutation(mutations);
    expect(queryString).toMatchSnapshot();
  });

  test('creates mutations with undefined and null fields', () => {
    const qa_TestCase = {
      uid: '<uid>',
      source: '<source>',
      name: '<name>',
      before: null,
      after: undefined,
      tags: ['tag1', 'tag2'],
    };

    const mutations = [qb.upsert({qa_TestCase})];
    const queryString = sut.batchMutation(mutations);
    expect(queryString).toMatchSnapshot();
  });

  test('delete mutations with non-model objects', () => {
    const qa_TestCase = {
      uid: '<uid>',
      source: '<source>',
      name: '<name>',
      before: null,
      after: undefined,
      tags: ['tag1', 'tag2'],
    };

    const mutations = [qb.delete({qa_TestCase})];
    const queryString = sut.batchMutation(mutations);
    expect(queryString).toMatchSnapshot();
  });

  test('delete mutations with model refs', () => {
    const mutations = [qb.delete({cicd_Deployment}), qb.delete({cicd_Build})];
    const queryString = sut.batchMutation(mutations);
    expect(queryString).toMatchSnapshot();
  });

  test('upsert undefined ref', () => {
    const cicd_Pipeline = {
      uid: '<pipeline_uid>',
      organization: qb.ref(undefined),
    };
    const mutations = [qb.upsert({cicd_Pipeline})];
    const queryString = sut.batchMutation(mutations);
    expect(queryString).toMatchSnapshot();
  });

  test('delete undefined ref', () => {
    const cicd_Pipeline = {
      uid: '<pipeline_uid>',
      organization: qb.ref(undefined),
    };
    const mutations = [qb.delete({cicd_Pipeline})];
    const queryString = sut.batchMutation(mutations);
    expect(queryString).toMatchSnapshot();
  });

  test('upsert with conflict override', () => {
    const org_ApplicationOwnership = {
      team: qb.ref({org_Team: {uid: 'test_team'}}),
      application: qb.ref({
        compute_Application: {name: 'test_app', platform: 'test_platform'},
      }),
    };
    const mutations = [
      qb.upsert(
        {org_ApplicationOwnership},
        {
          constraint: 'org_ApplicationOwnership_application_id_unique',
          update_columns: ['teamId'],
        }
      ),
    ];
    const queryString = sut.batchMutation(mutations);
    expect(queryString).toMatchSnapshot();
  });
});

describe('arrayLiteral', () => {
  test('strings', () => {
    expect(sut.arrayLiteral(['a', 'b', 'c'])).toEqual('{"a","b","c"}');
    expect(sut.arrayLiteral(['"a', 'b"', '"c"'])).toEqual('{"a","b","c"}');
  });
});
