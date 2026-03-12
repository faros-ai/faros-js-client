import {GraphQLClient} from '../src/graphql/client/graphql-client';
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

  describe('batchMutation', () => {
    const batchMutation = GraphQLClient.batchMutation;

    test('creates mutations', () => {
      const mutations = [
        qb.upsert({compute_Application}),
        qb.upsert({cicd_Organization}),
        qb.upsert({cicd_Pipeline}),
        qb.upsert({cicd_Build}),
        qb.upsert({cicd_Deployment}),
      ];
      const queryString = batchMutation(mutations);
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
      const queryString = batchMutation(mutations);
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
      const queryString = batchMutation(mutations);
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
      const queryString = batchMutation(mutations);
      expect(queryString).toMatchSnapshot();
    });

    test('delete mutations with model refs', () => {
      const mutations = [
        qb.delete({cicd_Deployment}),
        qb.delete({cicd_Build}),
      ];
      const queryString = batchMutation(mutations);
      expect(queryString).toMatchSnapshot();
    });

    test('upsert undefined ref', () => {
      const cicd_Pipeline = {
        uid: '<pipeline_uid>',
        organization: qb.ref(undefined),
      };
      const mutations = [qb.upsert({cicd_Pipeline})];
      const queryString = batchMutation(mutations);
      expect(queryString).toMatchSnapshot();
    });

    test('delete undefined ref', () => {
      const cicd_Pipeline = {
        uid: '<pipeline_uid>',
        organization: qb.ref(undefined),
      };
      const mutations = [qb.delete({cicd_Pipeline})];
      const queryString = batchMutation(mutations);
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
      const queryString = batchMutation(mutations);
      expect(queryString).toMatchSnapshot();
    });
  });

  describe('bulkBatchMutation', () => {
    const bulkBatchMutation = GraphQLClient.bulkBatchMutation;

    test('creates mutations', () => {
      const mutations = [
        qb.upsert({compute_Application}),
        qb.upsert({cicd_Organization}),
        qb.upsert({cicd_Pipeline}),
        qb.upsert({cicd_Build}),
        qb.upsert({cicd_Deployment}),
      ];
      const queryString = bulkBatchMutation(mutations);
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
      const queryString = bulkBatchMutation(mutations);
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
      const queryString = bulkBatchMutation(mutations);
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
      const queryString = bulkBatchMutation(mutations);
      expect(queryString).toMatchSnapshot();
    });

    test('delete mutations with model refs', () => {
      const mutations = [
        qb.delete({cicd_Deployment}),
        qb.delete({cicd_Build}),
      ];
      const queryString = bulkBatchMutation(mutations);
      expect(queryString).toMatchSnapshot();
    });

    test('upsert undefined ref', () => {
      const cicd_Pipeline = {
        uid: '<pipeline_uid>',
        organization: qb.ref(undefined),
      };
      const mutations = [qb.upsert({cicd_Pipeline})];
      const queryString = bulkBatchMutation(mutations);
      expect(queryString).toMatchSnapshot();
    });

    test('delete undefined ref', () => {
      const cicd_Pipeline = {
        uid: '<pipeline_uid>',
        organization: qb.ref(undefined),
      };
      const mutations = [qb.delete({cicd_Pipeline})];
      const queryString = bulkBatchMutation(mutations);
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
      const queryString = bulkBatchMutation(mutations);
      expect(queryString).toMatchSnapshot();
    });

    test('groups multiple same-type inserts into bulk insert', () => {
      const app1 = {name: 'app1', platform: 'plat1'};
      const app2 = {name: 'app2', platform: 'plat2'};
      const mutations = [
        qb.upsert({compute_Application: app1}),
        qb.upsert({compute_Application: app2}),
      ];
      const queryString = bulkBatchMutation(mutations);
      expect(queryString).toMatchSnapshot();
      // Verify single bulk insert, not two individual ones
      expect(queryString).toContain('insert_compute_Application (objects:');
      expect(queryString).not.toContain('insert_compute_Application_one');
      expect(queryString!.match(/insert_compute_Application/g)).toHaveLength(1);
    });

    test('mixed inserts and deletes', () => {
      const mutations = [
        qb.upsert({compute_Application}),
        qb.delete({cicd_Build}),
        qb.upsert({cicd_Organization}),
      ];
      const queryString = bulkBatchMutation(mutations);
      expect(queryString).toMatchSnapshot();
      expect(queryString).toContain('insert_compute_Application (objects:');
      expect(queryString).toContain('insert_cicd_Organization (objects:');
      expect(queryString).toContain('delete_cicd_Build');
    });

    test('same model with different on_conflict stays separate', () => {
      const mutations = [
        qb.upsert({compute_Application}),
        qb.upsert(
          {compute_Application: {name: 'other', platform: 'other'}},
          {constraint: 'custom_constraint', update_columns: ['name']}
        ),
      ];
      const queryString = bulkBatchMutation(mutations);
      expect(queryString!.match(/insert_compute_Application/g)).toHaveLength(2);
      expect(queryString).toContain('compute_Application_pkey');
      expect(queryString).toContain('custom_constraint');
      expect(queryString).toMatchSnapshot();
    });

    test('groups same-type inserts with nested refs', () => {
      const pipeline1 = {
        uid: 'pipeline-1',
        organization: qb.ref({cicd_Organization: {uid: 'org-1', source: 'GitHub'}}),
      };
      const pipeline2 = {
        uid: 'pipeline-2',
        organization: qb.ref({cicd_Organization: {uid: 'org-2', source: 'GitHub'}}),
      };
      const mutations = [
        qb.upsert({cicd_Pipeline: pipeline1}),
        qb.upsert({cicd_Pipeline: pipeline2}),
      ];
      const queryString = bulkBatchMutation(mutations);
      expect(queryString).toMatchSnapshot();
      // Both pipelines grouped into one bulk insert
      expect(queryString!.match(/insert_cicd_Pipeline/g)).toHaveLength(1);
      // Nested refs preserved inside the objects array
      expect(queryString).toContain('org-1');
      expect(queryString).toContain('org-2');
      expect(queryString).toContain('cicd_Organization_pkey');
    });

    test('no insert_*_one appears in output', () => {
      const mutations = [
        qb.upsert({compute_Application}),
        qb.upsert({cicd_Organization}),
        qb.upsert({cicd_Pipeline}),
      ];
      const queryString = bulkBatchMutation(mutations);
      expect(queryString).not.toMatch(/_one[\s(]/);
    });
  });
});

describe('arrayLiteral', () => {
  test('strings', () => {
    expect(sut.arrayLiteral(['a', 'b', 'c'])).toEqual('{"a","b","c"}');
    expect(sut.arrayLiteral(['"a', 'b"', '"c"'])).toEqual('{"a","b","c"}');
  });
});
