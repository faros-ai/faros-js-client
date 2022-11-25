import 'jest-extended';

import * as gql from 'graphql';

import * as sut from '../src/graphql/graphql';
import {
  graphSchema,
  graphSchemaForPrimaryKeysTest,
  graphSchemaV2,
  graphSchemaV2ForPrimaryKeysTest,
  loadQueryFile,
  toArray,
} from './helpers';

describe('graphql', () => {
  test('query nodes paths', async () => {
    const query = await loadQueryFile('deployments.gql');
    expect(sut.queryNodesPaths(query)).toIncludeSameMembers([
      ['cicd', 'deployments', 'nodes'],
      ['cicd', 'deployments', 'nodes', 'changeset', 'nodes'],
    ]);
  });

  test('paginated query', async () => {
    const query = await loadQueryFile('deployments.gql');
    const expectedQuery = await loadQueryFile('paginated-deployments.gql');
    const paginatedQuery = sut.paginatedQuery(query);
    expect(paginatedQuery.edgesPath).toEqual(['cicd', 'deployments', 'edges']);
    expect(paginatedQuery.pageInfoPath).toEqual([
      'cicd',
      'deployments',
      'pageInfo',
    ]);
    expect(paginatedQuery.query).toEqual(expectedQuery);
  });

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
    const query = await loadQueryFile('commits-v2.gql');
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
    const query = await loadQueryFile('incidents-v2.gql');
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

    const query = await loadQueryFile('pull_request-v2.gql');
    const ctx = sut.flattenV2(query, graphSchemaV2);
    const flattenedNodes = sut.flattenIterable(ctx, nodes);
    expect(await toArray(flattenedNodes)).toMatchSnapshot();
  });

  test('paginated v2 query', async () => {
    const query = await loadQueryFile('commits-v2.gql');
    const expectedQuery = await loadQueryFile('paginated-commits-v2.gql');
    const paginatedQuery = sut.paginatedQueryV2(query);
    expect(paginatedQuery.edgesPath).toEqual([
      'vcs_Commit_connection',
      'edges',
    ]);
    expect(paginatedQuery.pageInfoPath).toEqual([
      'vcs_Commit_connection',
      'pageInfo',
    ]);
    expect(paginatedQuery.query).toEqual(expectedQuery);
  });

  test('build incremental V2', () => {
    const type = graphSchemaV2.getType('cicd_Build');
    const query1 = sut.buildIncrementalQueryV2(type as gql.GraphQLObjectType);
    expect(query1).toMatchSnapshot();
    const query2 = sut.buildIncrementalQueryV2(
      type as gql.GraphQLObjectType,
      false
    );
    expect(query2).toMatchSnapshot();
  });

  test('build incremental V1', () => {
    const type = graphSchema.getType('cicd_Build');
    const query1 = sut.buildIncrementalQueryV1(type as gql.GraphQLObjectType);
    expect(query1).toMatchSnapshot();
    const query2 = sut.buildIncrementalQueryV1(
      type as gql.GraphQLObjectType,
      false
    );
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

  test('flatten nodes', async () => {
    const nodes = [
      {
        deploymentUid: 'deploy1',
        application: {appName: 'app1'},
        changeset: {
          nodes: [{commit: {sha: 'sha1'}}, {commit: {sha: 'sha2'}}],
        },
      },
      {
        deploymentUid: 'deploy2',
        application: {appName: 'app2'},
        changeset: {
          nodes: [{commit: {sha: 'sha3'}}, {commit: {sha: 'sha4'}}],
        },
      },
      {
        deploymentUid: 'deploy3',
        application: {appName: 'app3'},
        changeset: {nodes: []},
      },
      {
        deploymentUid: 'deploy4',
        application: {appName: 'app4'},
        changeset: {nodes: null},
      },
    ];

    const query = await loadQueryFile('deployments.gql');
    const ctx = sut.flatten(query, graphSchema);
    const flattenedNodes = sut.flattenIterable(ctx, nodes);
    expect(ctx.fieldTypes).toEqual(
      new Map([
        ['deployment_uid', gql.GraphQLID],
        ['app_name', gql.GraphQLString],
        ['sha', gql.GraphQLString],
      ])
    );
    expect(Array.from(ctx.params.keys())).toIncludeSameMembers(['from']);
    function assertTypeAndValue(fld: string, type: string) {
      expect(gql.isScalarType(ctx.params.get(fld))).toBeTrue();
      expect((ctx.params.get(fld) as gql.GraphQLScalarType).name).toEqual(type);
    }
    assertTypeAndValue('from', 'builtin_BigInt');
    expect(await toArray(flattenedNodes)).toIncludeSameMembers([
      {deployment_uid: 'deploy1', app_name: 'app1', sha: 'sha1'},
      {deployment_uid: 'deploy1', app_name: 'app1', sha: 'sha2'},
      {deployment_uid: 'deploy2', app_name: 'app2', sha: 'sha3'},
      {deployment_uid: 'deploy2', app_name: 'app2', sha: 'sha4'},
      {deployment_uid: 'deploy3', app_name: 'app3'},
      {deployment_uid: 'deploy4', app_name: 'app4'},
    ]);
  });

  test('flatten nodes with cross join', async () => {
    const nodes = [
      {
        uid: 'task1',
        creator: {creatorUid: 'creator1'},
        projects: {
          nodes: [
            {project: {projectUid: 'project1'}},
            {
              project: {
                projectUid: 'project2',
                boards: {
                  nodes: [
                    {board: {boardUid: 'board1'}},
                    {board: {boardUid: 'board2'}},
                  ],
                },
              },
            },
          ],
        },
        assignees: {
          nodes: [
            {assignee: {assigneeUid: 'assignee1'}},
            {assignee: {assigneeUid: 'assignee2'}},
          ],
        },
      },
      {
        uid: 'task2',
        creator: {creatorUid: 'creator2'},
        projects: {
          nodes: [{project: {projectUid: 'project3'}}],
        },
        assignees: {
          nodes: [{assignee: {assigneeUid: 'assignee3'}}],
        },
      },
      {
        uid: 'task3',
        creator: {creatorUid: 'creator3'},
        projects: {
          nodes: [{project: {projectUid: 'project4'}}],
        },
      },
      {
        uid: 'task4',
        creator: {creatorUid: 'creator4'},
        projects: {nodes: []},
      },
      {
        uid: 'task5',
        creator: {creatorUid: 'creator5'},
        projects: {nodes: null},
      },
    ];

    const query = await loadQueryFile('tasks.gql');
    const ctx = sut.flatten(query, graphSchema);
    const flattenedNodes = sut.flattenIterable(ctx, nodes);
    expect(ctx.fieldTypes).toEqual(
      new Map([
        ['uid', gql.GraphQLID],
        ['creator_uid', gql.GraphQLID],
        ['project_uid', gql.GraphQLID],
        ['board_uid', gql.GraphQLString],
        ['assignee_uid', gql.GraphQLID],
      ])
    );
    expect(await toArray(flattenedNodes)).toIncludeSameMembers([
      {
        uid: 'task1',
        creator_uid: 'creator1',
        project_uid: 'project1',
        assignee_uid: 'assignee1',
      },
      {
        uid: 'task1',
        creator_uid: 'creator1',
        project_uid: 'project1',
        assignee_uid: 'assignee2',
      },
      {
        uid: 'task1',
        creator_uid: 'creator1',
        project_uid: 'project2',
        board_uid: 'board1',
        assignee_uid: 'assignee1',
      },
      {
        uid: 'task1',
        creator_uid: 'creator1',
        project_uid: 'project2',
        board_uid: 'board2',
        assignee_uid: 'assignee1',
      },
      {
        uid: 'task1',
        creator_uid: 'creator1',
        project_uid: 'project2',
        board_uid: 'board1',
        assignee_uid: 'assignee2',
      },
      {
        uid: 'task1',
        creator_uid: 'creator1',
        project_uid: 'project2',
        board_uid: 'board2',
        assignee_uid: 'assignee2',
      },
      {
        uid: 'task2',
        creator_uid: 'creator2',
        project_uid: 'project3',
        assignee_uid: 'assignee3',
      },
      {
        uid: 'task3',
        creator_uid: 'creator3',
        project_uid: 'project4',
      },
      {
        uid: 'task4',
        creator_uid: 'creator4',
      },
      {
        uid: 'task5',
        creator_uid: 'creator5',
      },
    ]);
  });

  test('flatten empty nodes', async () => {
    const nodes: any[] = [];
    const query = await loadQueryFile('deployments.gql');
    const ctx = sut.flatten(query, graphSchema);
    const flattenedNodes = sut.flattenIterable(ctx, nodes);
    expect(ctx.fieldTypes).toEqual(
      new Map([
        ['deployment_uid', gql.GraphQLID],
        ['app_name', gql.GraphQLString],
        ['sha', gql.GraphQLString],
      ])
    );
    expect(await toArray(flattenedNodes)).toBeEmpty();
  });

  // Schema used for default value tests
  const graphDefaultSchema = new gql.GraphQLSchema({
    query: new gql.GraphQLObjectType({
      name: 'root',
      fields: {
        nodes: {
          type: new gql.GraphQLList(
            new gql.GraphQLObjectType({
              name: 'nodes',
              fields: {
                boolField: {type: gql.GraphQLBoolean},
                doubleField: {
                  type: new gql.GraphQLScalarType({
                    name: 'Double',
                    serialize(value) {
                      return value;
                    },
                  }),
                },
                floatField: {type: gql.GraphQLFloat},
                intField: {type: gql.GraphQLInt},
                longField: {
                  type: new gql.GraphQLScalarType({
                    name: 'Long',
                    serialize(value) {
                      return value;
                    },
                  }),
                },
                strField: {type: gql.GraphQLString},
                // Nested nodes field
                nodesField: {
                  type: new gql.GraphQLObjectType({
                    name: 'nestedNodes',
                    fields: {
                      nodes: {
                        type: new gql.GraphQLList(
                          new gql.GraphQLObjectType({
                            name: 'nestedNode',
                            fields: {
                              nestedStrField: {type: gql.GraphQLString},
                            },
                          })
                        ),
                      },
                    },
                  }),
                },
              },
            })
          ),
        },
      },
    }),
  });

  test('default values', async () => {
    const query = `
      query {
        nodes {
          boolField @default(value: "true")
          doubleField @default(value: "1.234")
          floatField @default(value: "1.23")
          intField @default(value: "123")
          longField @default(value: "1234")
          strField @default(value: "str")
          nodesField {
            nodes {
              nestedStrField @default(value: "str")
            }
          }
        }
      }
    `;
    const nodes = [
      // All fields undefined
      {},
      // All fields null
      {
        boolField: null,
        doubleField: null,
        floatField: null,
        intField: null,
        longField: null,
        strField: null,
        nodesFields: {
          nodes: [{nestedStrField: null}],
        },
      },
      // All fields "empty" values. Defaults should NOT be used.
      {
        boolField: false,
        doubleField: 0.0,
        floatField: 0.0,
        intField: 0,
        longField: 0,
        strField: '',
        nodesField: {
          nodes: [{nestedStrField: ''}],
        },
      },
    ];
    const ctx = sut.flatten(query, graphDefaultSchema);
    const flattenedNodes = sut.flattenIterable(ctx, nodes);
    expect(await toArray(flattenedNodes)).toIncludeSameMembers([
      {
        bool_field: true,
        double_field: 1.234,
        float_field: 1.23,
        int_field: 123,
        long_field: 1234,
        str_field: 'str',
        nested_str_field: 'str',
      },
      {
        bool_field: true,
        double_field: 1.234,
        float_field: 1.23,
        int_field: 123,
        long_field: 1234,
        str_field: 'str',
        nested_str_field: 'str',
      },
      {
        bool_field: false,
        double_field: 0.0,
        float_field: 0.0,
        int_field: 0,
        long_field: 0,
        str_field: '',
        nested_str_field: '',
      },
    ]);
  });

  test('invalid default values', () => {
    const nullQuery = `
      query {
        nodes {
          strField @default(value: null)
        }
      }
    `;
    const noValueQuery = `
      query {
        nodes {
          strField @default
        }
      }
    `;
    const boolQuery = `
      query {
        nodes {
          boolField @default(value: "123")
        }
      }
    `;
    const doubleQuery = `
      query {
        nodes {
          doubleField @default(value: "")
        }
      }
    `;
    const floatQuery = `
      query {
        nodes {
          floatField @default(value: "true")
        }
      }
    `;
    const intQuery = `
      query {
        nodes {
          intField @default(value: "1.23")
        }
      }
    `;
    const longQuery = `
      query {
        nodes {
          longField @default(value: "1.234")
        }
      }
    `;
    const strQuery = `
      query {
        nodes {
          strField @default(value: 123)
        }
      }
    `;
    expect(() => sut.flatten(nullQuery, graphDefaultSchema)).toThrow(
      'invalid default on field \'nodes.strField\''
    );
    expect(() => sut.flatten(noValueQuery, graphDefaultSchema)).toThrow(
      'invalid default on field \'nodes.strField\''
    );
    expect(() => sut.flatten(boolQuery, graphDefaultSchema)).toThrow(
      'Boolean field \'nodes.boolField\' has invalid default'
    );
    expect(() => sut.flatten(doubleQuery, graphDefaultSchema)).toThrow(
      'Double field \'nodes.doubleField\' has invalid default'
    );
    expect(() => sut.flatten(floatQuery, graphDefaultSchema)).toThrow(
      'Float field \'nodes.floatField\' has invalid default'
    );
    expect(() => sut.flatten(intQuery, graphDefaultSchema)).toThrow(
      'Int field \'nodes.intField\' has invalid default'
    );
    expect(() => sut.flatten(longQuery, graphDefaultSchema)).toThrow(
      'Long field \'nodes.longField\' has invalid default'
    );
    expect(() => sut.flatten(strQuery, graphDefaultSchema)).toThrow(
      'invalid default on field \'nodes.strField\''
    );
  });

  test('query exceeds max node depth', async () => {
    const query = await loadQueryFile('max-node-depth.gql');
    expect(() => sut.flatten(query, graphSchema)).toThrow(
      'query exceeds max node depth of 10'
    );
  });

  test('convert to incremental V1', () => {
    const query = `query MyQuery {
      vcs {
        pullRequests {
          nodes {
            metadata {
              refreshedAt
            }
            title
            number
            reviews {
              nodes {
                reviewer {
                  name
                }
              }
            }
          }
        }
      }
    }`;
    expect(sut.toIncrementalV1(query)).toMatchSnapshot();
    const queryWithout_refreshedAt = `query MyQuery {
      vcs {
        pullRequests {
          nodes {
            metadata {
              origin
            }
            title
            number
            reviews {
              nodes {
                reviewer {
                  name
                }
              }
            }
          }
        }
      }
    }`;
    expect(sut.toIncrementalV1(queryWithout_refreshedAt)).toMatchSnapshot();
    const queryWithout_metadata = `query MyQuery {
      vcs {
        pullRequests {
          nodes {
            title
            number
            reviews {
              nodes {
                reviewer {
                  name
                }
              }
            }
          }
        }
      }
    }`;
    expect(sut.toIncrementalV1(queryWithout_metadata)).toMatchSnapshot();
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

  test('create incremental queries V1', () => {
    expect(sut.createIncrementalQueriesV1(graphSchema)).toMatchSnapshot();
    expect(
      sut.createIncrementalQueriesV1(graphSchema, undefined, false)
    ).toMatchSnapshot();
  });

  test('create incremental queries V1 with primary keys info', () => {
    const primaryKeys = {
      cicd_Build: ['pipeline', 'uid'],
      cicd_Deployment: ['source', 'uid'],
      cicd_Organization: ['source', 'uid'],
      cicd_Pipeline: ['organization', 'uid'],
      cicd_Repository: ['organization', 'uid'],
    };
    expect(
      sut.createIncrementalQueriesV1(graphSchemaForPrimaryKeysTest, primaryKeys)
    ).toMatchSnapshot();
    expect(
      sut.createIncrementalQueriesV1(
        graphSchemaForPrimaryKeysTest,
        primaryKeys,
        false
      )
    ).toMatchSnapshot();
  });

  test('create incremental queries V2', () => {
    expect(sut.createIncrementalQueriesV2(graphSchemaV2)).toMatchSnapshot();
    expect(
      sut.createIncrementalQueriesV2(graphSchemaV2, undefined, false)
    ).toMatchSnapshot();
  });

  test('create incremental queries V2 with primary keys info', () => {
    const primaryKeys = {
      cicd_Build: ['pipeline', 'uid'],
      cicd_Deployment: ['source', 'uid'],
      cicd_Organization: ['source', 'uid'],
      cicd_Pipeline: ['organizationId', 'uid'],
      cicd_Repository: ['organizationId', 'uid'],
    };
    expect(
      sut.createIncrementalQueriesV2(
        graphSchemaV2ForPrimaryKeysTest,
        primaryKeys
      )
    ).toMatchSnapshot();
    expect(
      sut.createIncrementalQueriesV2(
        graphSchemaV2ForPrimaryKeysTest,
        primaryKeys,
        false
      )
    ).toMatchSnapshot();
  });

  test('path to model V1', () => {
    const query = `query MyQuery {
      cicd {
        deployments {
          nodes {
            url
            id
          }
        }
      }
    }`;
    expect(sut.pathToModelV1(query, graphSchema)).toEqual({
      modelName: 'cicd_Deployment',
      path: ['cicd', 'deployments', 'nodes'],
    });
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
});
