import 'jest-extended';

import * as gql from 'graphql';
import _ from 'lodash';

import {FarosClient} from '../src';
import * as sut from '../src/adapter';
import {
graphSchemaForAdapterTest as v1Schema,
graphSchemaV2ForAdapterTest as v2Schema,
toArray,
toIterator} from './helpers';

describe('AST utilities', () => {
  // Sorts fields and removes directives and aliases
  function normalizeAST(ast: gql.DocumentNode): gql.DocumentNode {
    return gql.visit(ast, {
      Directive() {
        return null;
      },
      Field(node) {
        if (node.alias) {
          return _.omit(node, 'alias');
        }
        return undefined;
      },
      SelectionSet: {
        leave(node) {
          return {
            ...node,
            selections: _.sortBy(node.selections, (s) => {
              if (s.kind === 'Field') {
                return s.name.value;
              }
              return undefined;
            })
          };
        }
      }
    });
  }

  interface ConversionAssertion {
    readonly v1Query: string;
    readonly v2Query: string;
    readonly fieldPaths?: sut.FieldPaths;
    readonly failureMessage?: string;
  }

  function expectConversion(assertion: ConversionAssertion): void {
    // const message = assertion.failureMessage;
    const v1TypeInfo = new gql.TypeInfo(v1Schema);
    const v1AST = normalizeAST(gql.parse(assertion.v1Query));
    const v2AST = normalizeAST(gql.parse(assertion.v2Query));
    const actualV2AST = normalizeAST(
      sut.asV2AST(v1AST, v1TypeInfo) as gql.DocumentNode
    );
    expect(gql.validate(v1Schema, v1AST)).toBeEmpty();
    expect(gql.validate(v2Schema, v2AST)).toBeEmpty();
    expect(gql.print(actualV2AST)).toEqual(gql.print(v2AST));
    const fieldPaths = assertion.fieldPaths;
    if (fieldPaths) {
      expect(sut.getFieldPaths(v1AST, v1TypeInfo)).toEqual(fieldPaths);
    }
  }

  test('rewrite namespace', () => {
    expectConversion({
      v1Query: `
        {
          cicd {
            deploymentChangesets {
              nodes {
                deployment {
                  id
                  uid
                }
                commit {
                  id
                  sha
                }
              }
            }
          }
        }
      `,
      v2Query: `
        {
          cicd_DeploymentChangeset {
            deployment {
              id
              uid
            }
            commit {
              id
              sha
            }
          }
        }
      `,
      fieldPaths: {
        cicd_DeploymentChangeset: {
          path: 'cicd.deploymentChangesets.nodes',
          nestedPaths: {
            'deployment.id': {
              path: 'deployment.id',
              type: 'string'
            },
            'deployment.uid': {
              path: 'deployment.uid',
              type: 'string'
            },
            'commit.id': {
              path: 'commit.id',
              type: 'string'
            },
            'commit.sha': {
              path: 'commit.sha',
              type: 'string'
            }
          }
        }
      }
    });
  });

  test('flatten metadata fields', () => {
    expectConversion({
      v1Query: `
        {
          cicd {
            deploymentChangesets {
              nodes {
                deployment {
                  uid
                  metadata {
                    origin
                    isPhantom
                    refreshedAt
                  }
                }
                commit {
                  sha
                  metadata {
                    origin
                    isPhantom
                    refreshedAt
                  }
                }
              }
            }
          }
        }
      `,
      v2Query: `
        {
          cicd_DeploymentChangeset {
            deployment {
              uid
              origin
              isPhantom
              refreshedAt
            }
            commit {
              sha
              origin
              isPhantom
              refreshedAt
            }
          }
        }
      `,
      fieldPaths: {
        cicd_DeploymentChangeset: {
          path: 'cicd.deploymentChangesets.nodes',
          nestedPaths: {
            'deployment.uid': {
              path: 'deployment.uid',
              type: 'string'
            },
            'deployment.origin': {
              path: 'deployment.metadata.origin',
              type: 'string'
            },
            'deployment.isPhantom': {
              path: 'deployment.metadata.isPhantom',
              type: 'boolean'
            },
            'deployment.refreshedAt': {
              path: 'deployment.metadata.refreshedAt',
              type: 'epoch_millis_string'
            },
            'commit.sha': {
              path: 'commit.sha',
              type: 'string'
            },
            'commit.origin': {
              path: 'commit.metadata.origin',
              type: 'string'
            },
            'commit.isPhantom': {
              path: 'commit.metadata.isPhantom',
              type: 'boolean'
            },
            'commit.refreshedAt': {
              path: 'commit.metadata.refreshedAt',
              type: 'epoch_millis_string'
            }
          }
        }
      }
    });
  });

  test('flatten embedded fields', () => {
    expectConversion({
      v1Query: `
        {
          cicd {
            deployments {
              nodes {
                uid
                env {
                  category
                  detail
                }
              }
            }
          }
        }
      `,
      v2Query: `
        {
          cicd_Deployment {
            uid
            envCategory
            envDetail
          }
        }
      `,
      fieldPaths: {
        cicd_Deployment: {
          path: 'cicd.deployments.nodes',
          nestedPaths: {
            uid: {
              path: 'uid',
              type: 'string'
            },
            envCategory: {
              path: 'env.category',
              type: 'string'
            },
            envDetail: {
              path: 'env.detail',
              type: 'string'
            }
          }
        }
      }
    });
  });

  test('remove nodes', () => {
    expectConversion({
      v1Query: `
        {
          vcs {
            commits {
              nodes {
                sha
                deployments {
                  nodes {
                    deployment {
                      uid
                    }
                  }
                }
              }
            }
          }
        }
      `,
      v2Query: `
        {
          vcs_Commit {
            sha
            deployments {
              deployment {
                uid
              }
            }
          }
        }
      `,
      fieldPaths: {
        vcs_Commit: {
          path: 'vcs.commits.nodes',
          nestedPaths: {
            sha: {
              path: 'sha',
              type: 'string'
            },
            deployments: {
              path: 'deployments.nodes',
              nestedPaths: {
                'deployment.uid': {
                  path: 'deployment.uid',
                  type: 'string'
                }
              }
            }
          }
        }
      }
    });
  });

  test('remove nested fields from embedded object lists', () => {
    expectConversion({
      v1Query: `
        {
          tms {
            tasks {
              nodes {
                uid
                additionalFields {
                  name
                  value
                }
                statusChangelog {
                  changedAt
                  status {
                    category
                    detail
                  }
                }
              }
            }
          }
        }
      `,
      v2Query: `
        {
          tms_Task {
            uid
            additionalFields
            statusChangelog
          }
        }
      `,
      fieldPaths: {
        tms_Task: {
          path: 'tms.tasks.nodes',
          nestedPaths: {
            uid: {
              path: 'uid',
              type: 'string'
            },
            additionalFields: {
              path: 'additionalFields',
              nestedPaths: {
                name: {
                  path: 'name',
                  type: 'string'
                },
                value: {
                  path: 'value',
                  type: 'string'
                }
              }
            },
            statusChangelog: {
              path: 'statusChangelog',
              nestedPaths: {
                changedAt: {
                  path: 'changedAt',
                  type: 'epoch_millis'
                },
                'status.category': {
                  path: 'status.category',
                  type: 'string'
                },
                'status.detail': {
                  path: 'status.detail',
                  type: 'string'
                }
              }
            }
          }
        }
      }
    });
  });

  test('rename first field argument to limit', () => {
    expectConversion({
      v1Query: `
        {
          cicd {
            deployments {
              nodes {
                uid
                changeset(first: 1) {
                  nodes {
                    commit {
                      sha
                    }
                  }
                }
              }
            }
          }
        }
      `,
      v2Query: `
        {
          cicd_Deployment {
            uid
            changeset(limit: 1) {
              commit {
                sha
              }
            }
          }
        }
      `,
      fieldPaths: {
        cicd_Deployment: {
          path: 'cicd.deployments.nodes',
          nestedPaths: {
            uid: {
              path: 'uid',
              type: 'string'
            },
            changeset: {
              path: 'changeset.nodes',
              nestedPaths: {
                'commit.sha': {
                  path: 'commit.sha',
                  type: 'string'
                }
              }
            }
          }
        }
      }
    });
  });

  test('all rules', () => {
    expectConversion({
      v1Query: `
        {
          tms {
            projects {
              nodes {
                uid
                description
                createdAt
                metadata {
                  origin
                  refreshedAt
                }
                releases {
                  nodes {
                    release {
                      uid
                      releasedAt
                      metadata {
                        origin
                        refreshedAt
                      }
                    }
                  }
                }
                tasks {
                  nodes {
                    task {
                      uid
                      type {
                        category
                        detail
                      }
                      metadata {
                        origin
                        refreshedAt
                      }
                      parent {
                        uid
                        createdAt
                      }
                      additionalFields {
                        name
                        value
                      }
                      statusChangelog {
                        changedAt
                        status {
                          category
                          detail
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      v2Query: `
        {
          tms_Project {
            uid
            description
            createdAt
            origin
            refreshedAt
            releases {
              release {
                uid
                releasedAt
                origin
                refreshedAt
              }
            }
            tasks {
              task {
                uid
                typeCategory
                typeDetail
                origin
                refreshedAt
                parent {
                  uid
                  createdAt
                }
                additionalFields
                statusChangelog
              }
            }
          }
        }
      `,
      fieldPaths: {
        tms_Project: {
          path: 'tms.projects.nodes',
          nestedPaths: {
            uid: {path: 'uid', type: 'string'},
            description: {path: 'description', type: 'string'},
            createdAt: {path: 'createdAt', type: 'epoch_millis_string'},
            origin: {path: 'metadata.origin', type: 'string'},
            refreshedAt: {
              path: 'metadata.refreshedAt',
              type: 'epoch_millis_string',
            },
            releases: {
              path: 'releases.nodes',
              nestedPaths: {
                'release.uid': {
                  path: 'release.uid',
                  type: 'string',
                },
                'release.releasedAt': {
                  path: 'release.releasedAt',
                  type: 'epoch_millis_string',
                },
                'release.origin': {
                  path: 'release.metadata.origin',
                  type: 'string',
                },
                'release.refreshedAt': {
                  path: 'release.metadata.refreshedAt',
                  type: 'epoch_millis_string',
                },
              },
            },
            tasks: {
              path: 'tasks.nodes',
              nestedPaths: {
                'task.uid': {
                  path: 'task.uid',
                  type: 'string',
                },
                'task.typeCategory': {
                  path: 'task.type.category',
                  type: 'string',
                },
                'task.typeDetail': {
                  path: 'task.type.detail',
                  type: 'string',
                },
                'task.origin': {
                  path: 'task.metadata.origin',
                  type: 'string',
                },
                'task.refreshedAt': {
                  path: 'task.metadata.refreshedAt',
                  type: 'epoch_millis_string',
                },
                'task.parent.uid': {
                  path: 'task.parent.uid',
                  type: 'string',
                },
                'task.parent.createdAt': {
                  path: 'task.parent.createdAt',
                  type: 'epoch_millis_string',
                },
                'task.additionalFields': {
                  path: 'task.additionalFields',
                  nestedPaths: {
                    name: {path: 'name', type: 'string'},
                    value: {path: 'value', type: 'string'},
                  },
                },
                'task.statusChangelog': {
                  path: 'task.statusChangelog',
                  nestedPaths: {
                    changedAt: {
                      path: 'changedAt',
                      type: 'epoch_millis',
                    },
                    'status.category': {
                      path: 'status.category',
                      type: 'string',
                    },
                    'status.detail': {
                      path: 'status.detail',
                      type: 'string',
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });
});

describe('query adapter', () => {
  interface RunV1Query {
    readonly v1Query: string;
    readonly v2Nodes: any[];
  }

  interface RunV2Query {
    readonly v2Query: string;
    readonly v2Nodes: any[];
  }

  function asV1Nodes(run: RunV1Query): AsyncIterable<any> {
    const nodeIterable = () => toIterator(run.v2Nodes);
    const faros: FarosClient = {graphVersion: 'v2', nodeIterable} as any;
    const adapter = new sut.QueryAdapter(faros, v1Schema);
    return adapter.nodes('default', run.v1Query);
  }

  function asV2Nodes(run: RunV2Query): AsyncIterable<any> {
    const nodeIterable = () => toIterator(run.v2Nodes);
    const faros: FarosClient = {graphVersion: 'v2', nodeIterable} as any;
    const adapter = new sut.QueryAdapter(faros, v1Schema, v2Schema);
    return adapter.nodes('default', run.v2Query);
  }

  test('invalid faros client fails', () => {
    const faros: FarosClient = {graphVersion: 'v1'} as any;
    expect(() => new sut.QueryAdapter(faros, v1Schema))
      .toThrowError('query adapter only works with v2 clients');
  });

  test('query', async () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          cicd {
            deploymentChangesets {
              nodes {
                deployment {
                  uid
                }
                commit {
                  sha
                }
              }
            }
          }
        }
      `,
      v2Nodes: [
        {deployment: {uid: 'u1'}, commit: {sha: 's1'}},
        {deployment: {uid: 'u2'}, commit: {sha: 's2'}}
      ]
    });
    await expect(toArray(v1Nodes)).resolves.toEqual([
      {deployment: {uid: 'u1'}, commit: {sha: 's1'}},
      {deployment: {uid: 'u2'}, commit: {sha: 's2'}}
    ]);
  });

  test('query v2', async () => {
    const v2Nodes = asV2Nodes({
      v2Query: `
        {
          cicd_DeploymentChangeset {
            deployment {
              uid
            }
            commit {
              sha
            }
          }
        }
      `,
      v2Nodes: [
        {deployment: {uid: 'u1'}, commit: {sha: 's1'}},
        {deployment: {uid: 'u2'}, commit: {sha: 's2'}}
      ]
    });
    await expect(toArray(v2Nodes)).resolves.toEqual([
      {deployment: {uid: 'u1'}, commit: {sha: 's1'}},
      {deployment: {uid: 'u2'}, commit: {sha: 's2'}}
    ]);
  });

  test('query with embedded fields', async () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          cicd {
            deployments {
              nodes {
                uid
                env {
                  category
                  detail
                }
              }
            }
          }
        }
      `,
      v2Nodes: [
        {
          uid: 'u1',
          envCategory: 'c1',
          envDetail: 'd1'
        },
        {
          uid: 'u2',
          envCategory: 'c2',
          envDetail: 'd2'
        },
      ]
    });
    await expect(toArray(v1Nodes)).resolves.toEqual([
      {uid: 'u1', env: {category: 'c1', detail: 'd1'}},
      {uid: 'u2', env: {category: 'c2', detail: 'd2'}},
    ]);
  });

  test('query with embedded fields v2', async () => {
    const v2Nodes = asV2Nodes({
      v2Query: `
        {
          cicd_Deployment {
            uid
            envCategory
            envDetail
          }
        }
      `,
      v2Nodes: [
        {
          uid: 'u1',
          envCategory: 'c1',
          envDetail: 'd1'
        },
        {
          uid: 'u2',
          envCategory: 'c2',
          envDetail: 'd2'
        },
      ]
    });
    await expect(toArray(v2Nodes)).resolves.toEqual([
      {uid: 'u1', envCategory: 'c1', envDetail: 'd1'},
      {uid: 'u2', envCategory: 'c2', envDetail: 'd2'},
    ]);
  });

  test('query with embedded object list fields', async () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          tms {
            tasks {
              nodes {
                uid
                additionalFields {
                  name
                  value
                }
                statusChangelog {
                  changedAt
                  status {
                    category
                    detail
                  }
                }
              }
            }
          }
        }
      `,
      v2Nodes: [
        {
          uid: 'u1',
          additionalFields: [
            {name: 'n1a', value: 'v1a'},
            {name: 'n1b', value: 'v1b'},
          ],
          statusChangelog: [
            {
              changedAt: 1667871145261,
              status: {category: 'c1a', detail: 'd1a'}
            },
            {
              changedAt: '2022-11-08T01:32:25.261Z',
              status: {category: 'c1b', detail: 'd1b'}
            }
          ]
        },
        {
          uid: 'u2',
          additionalFields: [
            {name: 'n2a', value: 'v2a'},
            {name: 'n2b', value: 'v2b'},
          ],
          statusChangelog: [
            {
              changedAt: 1667871145261,
              status: {category: 'c2a', detail: 'd2a'}
            },
            {
              changedAt: '2022-11-08T01:32:25.261Z',
              status: {category: 'c2b', detail: 'd2b'}
            }
          ]
        },
      ]
    });
    await expect(toArray(v1Nodes)).resolves.toEqual([
      {
        uid: 'u1',
        additionalFields: [
          {name: 'n1a', value: 'v1a'},
          {name: 'n1b', value: 'v1b'},
        ],
        statusChangelog: [
          {
            changedAt: 1667871145261,
            status: {category: 'c1a', detail: 'd1a'}
          },
          {
            changedAt: 1667871145261,
            status: {category: 'c1b', detail: 'd1b'}
          }
        ]
      },
      {
        uid: 'u2',
        additionalFields: [
          {name: 'n2a', value: 'v2a'},
          {name: 'n2b', value: 'v2b'},
        ],
        statusChangelog: [
          {
            changedAt: 1667871145261,
            status: {category: 'c2a', detail: 'd2a'}
          },
          {
            changedAt: 1667871145261,
            status: {category: 'c2b', detail: 'd2b'}
          }
        ]
      },
    ]);
  });

  test('query with embedded object list fields v2', async () => {
    const v2Nodes = asV2Nodes({
      v2Query: `
      {
        tms_Task {
          uid
          additionalFields 
          statusChangelog 
        }
      }
      `,
      v2Nodes: [
        {
          uid: 'u1',
          additionalFields: [
            {name: 'n1a', value: 'v1a'},
            {name: 'n1b', value: 'v1b'},
          ],
          statusChangelog: [
            {
              changedAt: 1667871145261,
              status: {category: 'c1a', detail: 'd1a'}
            },
            {
              changedAt: '2022-11-08T01:32:25.261Z',
              status: {category: 'c1b', detail: 'd1b'}
            }
          ]
        },
        {
          uid: 'u2',
          additionalFields: [
            {name: 'n2a', value: 'v2a'},
            {name: 'n2b', value: 'v2b'},
          ],
          statusChangelog: [
            {
              changedAt: 1667871145261,
              status: {category: 'c2a', detail: 'd2a'}
            },
            {
              changedAt: '2022-11-08T01:32:25.261Z',
              status: {category: 'c2b', detail: 'd2b'}
            }
          ]
        },
      ]
    });
    await expect(toArray(v2Nodes)).resolves.toEqual([
      {
        uid: 'u1',
        additionalFields: [
          {name: 'n1a', value: 'v1a'},
          {name: 'n1b', value: 'v1b'},
        ],
        statusChangelog: [
          {
            changedAt: 1667871145261,
            status: {category: 'c1a', detail: 'd1a'}
          },
          {
            changedAt: '2022-11-08T01:32:25.261Z',
            status: {category: 'c1b', detail: 'd1b'}
          }
        ]
      },
      {
        uid: 'u2',
        additionalFields: [
          {name: 'n2a', value: 'v2a'},
          {name: 'n2b', value: 'v2b'},
        ],
        statusChangelog: [
          {
            changedAt: 1667871145261,
            status: {category: 'c2a', detail: 'd2a'}
          },
          {
            changedAt: '2022-11-08T01:32:25.261Z',
            status: {category: 'c2b', detail: 'd2b'}
          }
        ]
      },
    ]);
  });

  test('query with nested nodes', async () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          tms {
            projects {
              nodes {
                uid
                tasks {
                  nodes {
                    task {
                      uid
                      createdAt
                    }
                  }
                }
              }
            }
          }
        }
      `,
      v2Nodes: [
        {
          uid: 'u1',
          tasks: [
            {task: {uid: 'u1a', createdAt: '2022-11-08T01:32:25.261Z'}},
            {task: {uid: 'u1b', createdAt: '2022-11-08T01:32:25.261Z'}}
          ],
        },
        {
          uid: 'u2',
          tasks: [
            {task: {uid: 'u2a', createdAt: '2022-11-08T01:32:25.261Z'}},
            {task: {uid: 'u2b', createdAt: '2022-11-08T01:32:25.261Z'}}
          ]
        }
      ]
    });
    await expect(toArray(v1Nodes)).resolves.toEqual([
      {
        uid: 'u1',
        tasks: {
          nodes: [
            {task: {uid: 'u1a', createdAt: '1667871145261'}},
            {task: {uid: 'u1b', createdAt: '1667871145261'}}
          ]
        }
      },
      {
        uid: 'u2',
        tasks: {
          nodes: [
            {task: {uid: 'u2a', createdAt: '1667871145261'}},
            {task: {uid: 'u2b', createdAt: '1667871145261'}}
          ]
        }
      }
    ]);
  });

  test('query with metadata', async () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          tms {
            tasks {
              nodes {
                uid
                metadata {
                  origin
                  isPhantom
                  refreshedAt
                }
              }
            }
          }
        }
      `,
      v2Nodes: [
        {
          uid: 'u1',
          origin: 'o1',
          isPhantom: true,
          refreshedAt: '2022-11-08T01:32:25.261Z'
        },
        {
          uid: 'u2',
          origin: 'o2',
          isPhantom: false,
          refreshedAt: '2022-11-08T01:32:25.261Z'
        }
      ]
    });
    await expect(toArray(v1Nodes)).resolves.toEqual([
      {
        uid: 'u1',
        metadata: {
          origin: 'o1',
          isPhantom: true,
          refreshedAt: '1667871145261'
        }
      },
      {
        uid: 'u2',
        metadata: {
          origin: 'o2',
          isPhantom: false,
          refreshedAt: '1667871145261'
        }
      }
    ]);
  });

  test('query with primitive list', async () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          vcs {
            repositories {
              nodes {
                topics
              }
            }
          }
        }
      `,
      v2Nodes: [
        {topics: ['t1a', 't1b']},
        {topics: ['t2a', 't2b']}
      ]
    });
    await expect(toArray(v1Nodes)).resolves.toEqual([
      {topics: ['t1a', 't1b']},
      {topics: ['t2a', 't2b']},
    ]);
  });

  test('query with timestamp type', async () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          cicd {
            deployments {
              nodes {
                startedAt
              }
            }
          }
        }
      `,
      v2Nodes: [{startedAt: '2022-11-08T01:32:25.261Z'}],
    });
    await expect(toArray(v1Nodes)).resolves.toEqual([
      {startedAt: '1667871145261'},
    ]);
  });

  test('throws error for invalid timestamp value', () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          cicd {
            deployments {
              nodes {
                startedAt
              }
            }
          }
        }
      `,
      v2Nodes: [{startedAt: 'invalid'}],
    });
    return expect(() => toArray(v1Nodes)).rejects.toThrow(/failed to convert/);
  });

  test('query with double type', async () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          geo {
            coordinates {
              nodes {
                lat
                lon
              }
            }
          }
        }
      `,
      v2Nodes: [
        {lat: '1.23456789', lon: '1.23456789'},
        {lat: '41.8839113', lon: '-87.6340954'}
      ]
    });
    await expect(toArray(v1Nodes)).resolves.toEqual([
      {lat: 1.23456789, lon: 1.23456789},
      {lat: 41.8839113, lon: -87.6340954}
    ]);
  });

  test('throws error for invalid double value', () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          geo {
            coordinates {
              nodes {
                lat
                lon
              }
            }
          }
        }
      `,
      v2Nodes: [
        {lat: '1.23456789', lon: 'invalid'},
      ]
    });
    return expect(() => toArray(v1Nodes)).rejects.toThrow(/failed to convert/);
  });

  test('query with long type', async () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          cal {
            events {
              nodes {
                durationMs
              }
            }
          }
        }
      `,
      v2Nodes: [{durationMs: '123456789'}],
    });
    await expect(toArray(v1Nodes)).resolves.toEqual([
      {durationMs: '123456789'},
    ]);
  });

  test('throws error for invalid long value', () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          cal {
            events {
              nodes {
                durationMs
              }
            }
          }
        }
      `,
      v2Nodes: [{durationMs: 'invalid'}],
    });
    return expect(() => toArray(v1Nodes)).rejects.toThrow(/failed to convert/);
  });

  test('edge case for v1 long and v2 int', async () => {
    const v1Nodes = asV1Nodes({
      v1Query: `
        {
          vcs {
            pullRequestComments {
              nodes {
                number
              }
            }
          }
        }
      `,
      v2Nodes: [{number: 123456789}],
    });
    await expect(toArray(v1Nodes)).resolves.toEqual([
      {number: '123456789'},
    ]);
  });
});
