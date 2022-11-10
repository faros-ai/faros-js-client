import axios from 'axios';
import fs from 'fs-extra';
import * as gql from 'graphql';
import path from 'path';
import {mocked} from 'ts-jest/utils';

import {FarosClient} from '../src/client';

jest.mock('axios');
jest.mock('axios-retry');

const mockedAxios = mocked(axios, true);

describe('index', () => {
  async function loadQueryFile(name: string): Promise<string> {
    const query = await fs.readFile(
      path.join(__dirname, 'resources', 'queries', name),
      'utf-8'
    );
    return gql.print(gql.parse(query));
  }

  function mockResponses(responses: ReadonlyArray<any>): jest.Mock<any, any> {
    const mockPost = jest.fn();
    for (const response of responses) {
      mockPost.mockResolvedValueOnce(response);
    }
    return mockPost;
  }

  beforeEach(() => mockedAxios.mockClear());

  test('iterate query results', async () => {
    const mockPost = mockResponses([
      {
        data: {
          data: {
            cicd: {
              deployments: {
                edges: [
                  {
                    cursor: 'abc',
                    node: {
                      uid: 'deployment1',
                      application: {name: 'app1'},
                      changeset: {
                        nodes: [{commit: {sha: 'sha1'}}],
                      },
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: true,
                },
              },
            },
          },
        },
      },
      {
        data: {
          data: {
            cicd: {
              deployments: {
                edges: [
                  {
                    cursor: 'def',
                    node: {
                      uid: 'deployment2',
                      application: {name: 'app2'},
                      changeset: {
                        nodes: [{commit: {sha: 'sha2'}}],
                      },
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: false,
                },
              },
            },
          },
        },
      },
    ]);
    mockedAxios.create.mockImplementation(() => ({post: mockPost} as any));

    const faros = new FarosClient({
      url: 'https://prod.api.faros.ai',
      apiKey: 'apiKey',
    });

    const query = await loadQueryFile('deployments.gql');
    const nodeUids = [];
    for await (const node of faros.nodeIterable('graph', query, 1)) {
      nodeUids.push(node.uid);
    }
    expect(nodeUids).toEqual(['deployment1', 'deployment2']);

    const expectedQuery = await loadQueryFile('paginated-deployments.gql');
    expect(mockPost).toHaveBeenNthCalledWith(1, '/graphs/graph/graphql', {
      query: expectedQuery,
      variables: {pageSize: 1},
    });
    expect(mockPost).toHaveBeenNthCalledWith(2, '/graphs/graph/graphql', {
      query: expectedQuery,
      variables: {cursor: 'abc', pageSize: 1},
    });
  });

  test('query with invalid operation', async () => {
    const faros = new FarosClient({
      url: 'https://prod.api.faros.ai',
      apiKey: 'apiKey',
    });

    const query = await loadQueryFile('mutation.gql');
    expect(() => faros.nodeIterable('graph', query)).toThrow(/invalid query/);
  });

  test('query with multiple selections', async () => {
    const faros = new FarosClient({
      url: 'https://prod.api.faros.ai',
      apiKey: 'apiKey',
    });

    const query = await loadQueryFile('multiple-selections.gql');
    expect(() => faros.nodeIterable('graph', query)).toThrow(/invalid query/);
  });
});
