import * as sut from '../src/graphql/query-builder';
import {Mutation} from '../src/types';

const ORIGIN = 'test-origin';

describe('query builder', () => {
  test('creates mutations', () => {
    const qb = new sut.QueryBuilder(ORIGIN);
    const mutations: Mutation[] = [];

    const application = {
      model: 'compute_Application',
      key: {
        name: '<application_name>',
        platform: '<application_platform>',
      },
    };
    const organization: sut.MutationParams = {
      model: 'cicd_Organization',
      key: {
        uid: '<organization_uid>',
        source: '<organization_source>',
      },
    };
    const pipeline: sut.MutationParams = {
      model: 'cicd_Pipeline',
      key: {
        uid: '<pipeline_uid>',
        organization: qb.ref(organization),
      },
    };
    const build: sut.MutationParams = {
      model: 'cicd_Build',
      key: {
        uid: '<cicd_Build>',
        pipeline: qb.ref(pipeline),
      },
      body: {
        name: '<build_name>',
      },
    };
    const deployment: sut.MutationParams = {
      model: 'cicd_Deployment',
      key: {
        uid: '<deployment_uid',
        source: '<deployment_source>',
      },
      body: {
        application: qb.ref(application),
        build: qb.ref(build),
        status: {
          category: 'Success',
          detail: '<status_detail>',
        },
      },
    };

    mutations.push(
      qb.upsert(application),
      qb.upsert(organization),
      qb.upsert(pipeline),
      qb.upsert(build),
      qb.upsert(deployment)
    );

    const queryString = sut.batchMutation(mutations);

    expect(queryString).toMatchSnapshot();
  });
});
