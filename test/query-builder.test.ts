import * as sut from '../src/graphql/query-builder';

const ORIGIN = 'test-origin';

describe('query builder', () => {
  test('creates mutations', () => {
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
    const qb = new sut.QueryBuilder(ORIGIN);

    const qa_TestCase = {
      uid: '<uid>',
      source: '<source>',
      name: '<name>',
      before: [{description: '<description>', condition: '<condition>'}],
      after: [{description: '<description>', condition: '<condition>'}],
      tags: ['tag1', 'tag2'],
    };

    const mutations = [qb.upsert({qa_TestCase})];
    const queryString = sut.batchMutation(mutations);
    expect(queryString).toMatchSnapshot();
  });
});
