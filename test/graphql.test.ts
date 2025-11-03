import 'jest-extended';

import * as gql from 'graphql';

import {FarosClient} from '../src/client';
import * as sut from '../src/graphql/graphql';
import {
  graphSchemaV2,
  graphSchemaV2ForForeignKeyExclusionTest,
  graphSchemaV2ForPrimaryKeysTest,
  loadQueryFile,
  toArray,
} from './helpers';

describe('graphql', () => {
  test('flatten nodes V2', async () => {
    const nodes = [
      {
        id: 'fc419273d9256727b0970326769edf1b99ae55da',
        author: {
          ownerId: 't1|ted|GitHub|nat-casey',
        },
      },
      {
        id: '32a4d92f46f02e9c10cca58e55874b6269690891',
        author: {
          ownerId: 't1|ted|GitHub|ypc-faros',
        },
      },
    ];
    const query = await loadQueryFile('commits.gql');
    const ctx = sut.flattenV2(query, graphSchemaV2);
    const flattenedNodes = sut.flattenIterable(ctx, nodes);
    expect(ctx.fieldTypes).toEqual(
      new Map([
        ['id', gql.GraphQLString],
        ['owner_id', gql.GraphQLString],
      ])
    );
    expect(Array.from(ctx.params.keys())).toIncludeSameMembers(['from', 'to']);
    function assertTypeAndValue(fld: string, type: string) {
      expect(gql.isScalarType(ctx.params.get(fld))).toBeTrue();
      expect((ctx.params.get(fld) as gql.GraphQLScalarType).name).toEqual(type);
    }
    assertTypeAndValue('to', 'timestamptz');
    assertTypeAndValue('from', 'timestamptz');
    expect(await toArray(flattenedNodes)).toIncludeSameMembers([
      {
        id: 'fc419273d9256727b0970326769edf1b99ae55da',
        owner_id: 't1|ted|GitHub|nat-casey',
      },
      {
        id: '32a4d92f46f02e9c10cca58e55874b6269690891',
        owner_id: 't1|ted|GitHub|ypc-faros',
      },
    ]);
  });

  test('flatten nodes V2 with jsonb array', () => {
    const query = `
      query ($from: timestamptz!, $to: timestamptz!) {
        cicd_Artifact (where: {refreshedAt: {_gte: $from, _lt: $to}})
          { id tags uid }
      }`;
    const ctx = sut.flattenV2(query, graphSchemaV2);
    for (const [id, type] of ctx.fieldTypes) {
      switch (id) {
        case 'id':
        case 'uid':
          expect(type).toEqual(gql.GraphQLString);
          break;
        case 'tags':
          {
            expect(type.constructor.name).toEqual('GraphQLList');
            const ofType = (type as gql.GraphQLList<gql.GraphQLScalarType>)
              .ofType;
            expect(ofType.name).toEqual('jsonb');
          }
          break;
        default:
          fail(`unexpected field ${id}`);
      }
    }
  });

  test('flatten nodes V2 with list rels', async () => {
    const nodes = [
      {
        incidentUid: 'Q0CYDYKOBEBSPZ',
        impactedApplications: [
          {
            application: {
              applicationName: 'unleash',
            },
          },
        ],
      },
      {
        incidentUid: 'Q0B4CLT0LU9OVT',
        impactedApplications: [
          {
            application: {
              applicationName: 'metabase',
            },
          },
        ],
      },
    ];
    const query = await loadQueryFile('incidents.gql');
    const ctx = sut.flattenV2(query, graphSchemaV2);
    const flattenedNodes = sut.flattenIterable(ctx, nodes);
    expect(ctx.fieldTypes).toEqual(
      new Map([
        ['incident_uid', gql.GraphQLString],
        ['application_name', gql.GraphQLString],
      ])
    );
    expect(await toArray(flattenedNodes)).toIncludeSameMembers([
      {incident_uid: 'Q0CYDYKOBEBSPZ', application_name: 'unleash'},
      {incident_uid: 'Q0B4CLT0LU9OVT', application_name: 'metabase'},
    ]);
  });

  test('flatten nodes V2 with lists within lists', async () => {
    const nodes = [
      {
        number: 37,
        repository: {
          repositoryName: 'airbyte-connectors',
        },
        author: {
          authorUid: 'Roma-Kyrnis',
          identity: [
            {
              identity: {
                authorIdentityName: 'roma',
                employee: [
                  {
                    authorLevel: 'ninja',
                  },
                ],
              },
            },
          ],
        },
      },
      {
        number: 39,
        repository: {
          repositoryName: 'airbyte-connectors',
        },
        author: {
          authorUid: 'tovbinm',
          identity: [
            {
              identity: {
                authorIdentityName: 'matthew',
                employee: [
                  {
                    authorLevel: 'master',
                  },
                ],
              },
            },
          ],
        },
      },
    ];

    const query = await loadQueryFile('pull-request.gql');
    const ctx = sut.flattenV2(query, graphSchemaV2);
    const flattenedNodes = sut.flattenIterable(ctx, nodes);
    expect(await toArray(flattenedNodes)).toMatchSnapshot();
  });

  test('flatten nodes V2 with invalid type', () => {
    expect(() => sut.flattenV2('{foo_Bar{id}}', graphSchemaV2)).toThrow(
      'invalid type \'foo_Bar\''
    );
  });

  test('paginated offset/limit query', async () => {
    const query = await loadQueryFile('commits.gql');
    const paginatedQuery = sut.paginateWithOffsetLimit(query);
    const expectedQuery = await loadQueryFile(
      'paginated-commits-offset-limit.gql'
    );
    expect(paginatedQuery.query).toEqual(expectedQuery);
    expect(paginatedQuery.edgesPath).toEqual(['vcs_Commit']);
    expect(paginatedQuery.pageInfoPath).toBeEmpty();
  });

  test('paginated keyset query', async () => {
    const query = await loadQueryFile('incidents.gql');
    const paginatedQuery = sut.paginateWithKeyset(query);
    const expectedQuery = await loadQueryFile(
      'paginated-incidents-keyset.gql'
    );
    expect(paginatedQuery.query).toEqual(expectedQuery);
    expect(paginatedQuery.edgesPath).toEqual(['ims_Incident']);
    expect(paginatedQuery.edgeIdPath).toEqual(['_id']);
    expect(paginatedQuery.pageInfoPath).toBeEmpty();
  });

  test('paginated keyset query with existing where clause', async () => {
    const query = await loadQueryFile('commits.gql');
    const paginatedQuery = sut.paginateWithKeyset(query);
    const expectedQuery = await loadQueryFile(
      'paginated-commits-keyset.gql'
    );
    expect(paginatedQuery.query).toEqual(expectedQuery);
    expect(paginatedQuery.edgesPath).toEqual(['vcs_Commit']);
    expect(paginatedQuery.edgeIdPath).toEqual(['_id']);
    expect(paginatedQuery.pageInfoPath).toBeEmpty();
  });

  test('build incremental V2', () => {
    const type = graphSchemaV2.getType('cicd_Build') as gql.GraphQLObjectType;
    const query1 = sut.buildIncrementalQueryV2({type});
    expect(query1).toMatchSnapshot();
    const query2 = sut.buildIncrementalQueryV2({
      type: type as gql.GraphQLObjectType,
      avoidCollisions: false,
    });
    expect(query2).toMatchSnapshot();
  });

  test('empty cross merge', async () => {
    expect(await toArray(sut.crossMerge([]))).toBeEmpty();
  });

  test('cross merge with empty iterable', async () => {
    const iters1 = [[{a: 1}, {b: 2}], []];
    expect(await toArray(sut.crossMerge(iters1))).toIncludeSameMembers([
      {a: 1},
      {b: 2},
    ]);

    const iters2 = [[], [{a: 1}, {b: 2}]];
    expect(await toArray(sut.crossMerge(iters2))).toIncludeSameMembers([
      {a: 1},
      {b: 2},
    ]);
  });

  test('single cross merge', async () => {
    const iters = [[{a: 1}, {b: 2}, {c: 3}]];
    expect(await toArray(sut.crossMerge(iters))).toIncludeSameMembers([
      {a: 1},
      {b: 2},
      {c: 3},
    ]);
  });

  test('double cross merge', async () => {
    const iters = [
      [{a: 1}, {b: 2}, {c: 3}],
      [{d: 4}, {e: 5}],
    ];
    expect(await toArray(sut.crossMerge(iters))).toIncludeSameMembers([
      {a: 1, d: 4},
      {a: 1, e: 5},
      {b: 2, d: 4},
      {b: 2, e: 5},
      {c: 3, d: 4},
      {c: 3, e: 5},
    ]);
  });

  test('triple cross merge', async () => {
    const iters = [
      [{a: 1}, {b: 2}, {c: 3}],
      [{d: 4}, {e: 5}],
      [{f: 6}, {g: 7}],
    ];
    expect(await toArray(sut.crossMerge(iters))).toIncludeSameMembers([
      {a: 1, d: 4, f: 6},
      {a: 1, d: 4, g: 7},
      {a: 1, e: 5, f: 6},
      {a: 1, e: 5, g: 7},
      {b: 2, d: 4, f: 6},
      {b: 2, d: 4, g: 7},
      {b: 2, e: 5, f: 6},
      {b: 2, e: 5, g: 7},
      {c: 3, d: 4, f: 6},
      {c: 3, d: 4, g: 7},
      {c: 3, e: 5, f: 6},
      {c: 3, e: 5, g: 7},
    ]);
  });

  test('convert to incremental V2', () => {
    const query = `query MyQuery {
      vcs_PullRequest {
        number
        title
        refreshedAt
      }
    }`;
    expect(sut.toIncrementalV2(query)).toMatchSnapshot();
    const query_without_refreshed_at = `query MyQuery {
      vcs_PullRequest {
        number
        title
      }
    }`;
    expect(sut.toIncrementalV2(query_without_refreshed_at)).toMatchSnapshot();
  });

  test('create incremental queries V2', () => {
    expect(
      sut.createIncrementalQueriesV2({graphSchema: graphSchemaV2})
    ).toMatchSnapshot();
    expect(
      sut.createIncrementalQueriesV2({
        graphSchema: graphSchemaV2,
        avoidCollisions: false,
      })
    ).toMatchSnapshot();
    expect(
      sut.createIncrementalQueriesV2({
        graphSchema: graphSchemaV2,
        avoidCollisions: false,
        scalarsOnly: true,
      })
    ).toMatchSnapshot();
  });

  test('create incremental queries V2 with primary keys/references', () => {
    const primaryKeys = {
      cicd_Build: ['pipeline', 'uid'],
      cicd_Deployment: ['source', 'uid'],
      cicd_Organization: ['source', 'uid'],
      cicd_Pipeline: ['organizationId', 'uid'],
      cicd_Repository: ['organizationId', 'uid'],
    };
    const organizationReferences = {
      organizationId: {
        field: 'organization',
        model: 'cicd_Organization',
        foreignKey: 'organizationId',
      },
      organization: {
        field: 'organization',
        model: 'cicd_Organization',
        foreignKey: 'organizationId',
      },
    };
    const references = {
      cicd_Pipeline: organizationReferences,
      cicd_Repository: organizationReferences,
    };
    expect(
      sut.createIncrementalQueriesV2({
        graphSchema: graphSchemaV2ForPrimaryKeysTest,
        primaryKeys,
        references,
        avoidCollisions: false
      })
    ).toMatchSnapshot();
  });

  test('create incremental queries V2 when missing expected field', () => {
    const primaryKeys = {
      cicd_Build: ['pipeline', 'uid'],
      cicd_Deployment: ['source', 'uid'],
      cicd_Organization: ['source', 'uid'],
      cicd_Pipeline: ['organizationId', 'uid'],
      cicd_Repository: ['organizationId', 'uid'],
    };
    expect(() =>
      sut.createIncrementalQueriesV2({
        graphSchema: graphSchemaV2ForPrimaryKeysTest,
        primaryKeys
      })
    ).toThrowErrorMatchingInlineSnapshot(
      '"expected organizationId to be a field of cicd_Pipeline"'
    );
    const organizationReferences = {
      organizationId: {
        field: 'missing_field',
        model: 'cicd_Organization',
        foreignKey: 'organizationId',
      },
      organization: {
        field: 'missing_field',
        model: 'cicd_Organization',
        foreignKey: 'organizationId',
      },
    };
    const references = {
      cicd_Pipeline: organizationReferences,
      cicd_Repository: organizationReferences,
    };
    expect(() =>
      sut.createIncrementalQueriesV2({
        graphSchema: graphSchemaV2ForPrimaryKeysTest,
        primaryKeys,
        references
      })
    ).toThrowErrorMatchingSnapshot();
  });

  test('excludes foreign key (scalar) identifier from selection', () => {
    const primaryKeys = {
      cicd_Organization: ['source', 'uid'],
      cicd_Pipeline: ['organizationId', 'uid'],
    };
    const organizationReferences = {
      organizationId: {
        field: 'organization',
        model: 'cicd_Organization',
        foreignKey: 'organizationId',
      },
      organization: {
        field: 'organization',
        model: 'cicd_Organization',
        foreignKey: 'organizationId',
      },
    };
    const references = {
      cicd_Pipeline: organizationReferences,
    };
    expect(
      sut.createIncrementalQueriesV2({
        graphSchema: graphSchemaV2ForForeignKeyExclusionTest,
        primaryKeys,
        references,
        avoidCollisions: false
      })
    ).toMatchSnapshot();
  });

  test('path to model V2', () => {
    const query = `query MyQuery {
      cicd_Build {
        number
        name
      }
    }`;
    expect(sut.pathToModelV2(query, graphSchemaV2)).toEqual({
      modelName: 'cicd_Build',
      path: ['cicd_Build'],
    });
  });

  test('create incremental reader', () => {
    const reader = sut.createIncrementalReader({
      model: 'cicd_Build',
      client: {} as unknown as FarosClient,
      graph: 'graph',
      graphSchema: graphSchemaV2,
      pageSize: 1,
      avoidCollisions: false,
      scalarsOnly: true,
    });

    expect(reader?.metadata).toMatchObject({
      name: 'cicd_Build',
      modelKeys: ['id'],
      incremental: true,
    });
  });

  test('create delete reader', () => {
    const reader = sut.createDeleteReader({
      model: 'cicd_Build',
      client: {} as unknown as FarosClient,
      graph: 'graph',
      graphSchema: graphSchemaV2,
      pageSize: 1,
    });

    expect(reader?.metadata).toMatchObject({
      name: 'cicd_Build',
      incremental: false,
    });
  });

  test('get graph models', () => {
    expect(sut.getGraphModels(graphSchemaV2)).toIncludeAllMembers([
      'cicd_Artifact',
      'cicd_Build',
      'cicd_Pipeline',
    ]);
  });
});
