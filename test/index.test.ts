import axios from 'axios';
import fs from 'fs-extra';
import * as gql from 'graphql';
import path from 'path';

import {FarosClient} from '../src/client';
import {paginateWithKeysetV2} from '../src/graphql/graphql';

jest.mock('axios');
jest.mock('axios-retry');

const mockedAxios = jest.mocked(axios);

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

  describe('nodeIterable', () => {
    test('iterate query results', async () => {
      const mockPost = mockResponses([
        {
          data: {
            data: {
              cicd_Deployment: [
                {
                  _id: 'abc',
                  uid: 'deployment1',
                  application: {appName: 'app1'},
                  changeset: [{commit: {sha: 'sha1'}}],
                },
              ],
            },
          },
        },
        {
          data: {
            data: {
              cicd_Deployment: [
                {
                  _id: 'def',
                  uid: 'deployment2',
                  application: {appName: 'app2'},
                  changeset: [{commit: {sha: 'sha2'}}],
                },
              ],
            },
          },
        },
        {
          data: {
            data: {
              cicd_Deployment: [],
            },
          },
        },
      ]);
      mockedAxios.create.mockImplementation(() => ({post: mockPost}) as any);

      const faros = new FarosClient({
        url: 'https://prod.api.faros.ai',
        apiKey: 'apiKey',
      });

      const query = await loadQueryFile('deployments.gql');
      const nodeUids: any[] = [];
      for await (const node of faros.nodeIterable('graph', query, 1)) {
        nodeUids.push(node.uid);
      }
      expect(nodeUids).toEqual(['deployment1', 'deployment2']);

      const expectedQuery = await loadQueryFile(
        'paginated-deployments-keyset-v1.gql'
      );
      expect(mockPost).toHaveBeenNthCalledWith(
        1,
        '/graphs/graph/graphql',
        {
          query: expectedQuery,
          variables: {_limit: 1},
        },
        expect.anything()
      );
      expect(mockPost).toHaveBeenNthCalledWith(
        2,
        '/graphs/graph/graphql',
        {
          query: expectedQuery,
          variables: {_id: 'abc', _limit: 1},
        },
        expect.anything()
      );
    });

    test('iterate query results using keyset v2', async () => {
      const mockPost = mockResponses([
        {
          data: {
            data: {
              cicd_Deployment: [
                {
                  _timestamp: '2024-01-01T00:00:00Z',
                  _id: 'abc',
                  uid: 'deployment1',
                  application: {appName: 'app1'},
                  changeset: [{commit: {sha: 'sha1'}}],
                },
              ],
            },
          },
        },
        {
          data: {
            data: {
              cicd_Deployment: [
                {
                  _timestamp: '2024-01-01T00:01:00Z',
                  _id: 'def',
                  uid: 'deployment2',
                  application: {appName: 'app2'},
                  changeset: [{commit: {sha: 'sha2'}}],
                },
              ],
            },
          },
        },
        {
          data: {
            data: {
              cicd_Deployment: [],
            },
          },
        },
      ]);
      mockedAxios.create.mockImplementation(() => ({post: mockPost}) as any);

      const faros = new FarosClient({
        url: 'https://prod.api.faros.ai',
        apiKey: 'apiKey',
      });

      const query = await loadQueryFile('deployments.gql');
      const nodeUids: any[] = [];
      for await (const node of faros.nodeIterable(
        'graph',
        query,
        1,
        paginateWithKeysetV2
      )) {
        nodeUids.push(node.uid);
      }
      expect(nodeUids).toEqual(['deployment1', 'deployment2']);

      const expectedQuery = await loadQueryFile(
        'paginated-deployments-keyset-v2.gql'
      );
      expect(mockPost).toHaveBeenNthCalledWith(
        1,
        '/graphs/graph/graphql',
        {
          query: expectedQuery,
          variables: {_limit: 1},
        },
        expect.anything()
      );
      expect(mockPost).toHaveBeenNthCalledWith(
        2,
        '/graphs/graph/graphql',
        {
          query: expectedQuery,
          variables: {
            _timestamp: '2024-01-01T00:00:00Z',
            _id: 'abc',
            _limit: 1,
          },
        },
        expect.anything()
      );
    });

    test('throws when node is missing keyset field', async () => {
      const mockPost = mockResponses([
        {
          data: {
            data: {
              cicd_Deployment: [
                {
                  _timestamp: '2024-01-01T00:00:00Z',
                  _id: null, // Missing keyset field
                  uid: 'deployment1',
                  application: {appName: 'app1'},
                  changeset: [{commit: {sha: 'sha1'}}],
                },
              ],
            },
          },
        },
      ]);
      mockedAxios.create.mockImplementation(() => ({post: mockPost}) as any);

      const faros = new FarosClient({
        url: 'https://prod.api.faros.ai',
        apiKey: 'apiKey',
      });

      const query = await loadQueryFile('deployments.gql');

      const nodeUids: any[] = [];
      await expect(async () => {
        for await (const node of faros.nodeIterable(
          'graph',
          query,
          1,
          paginateWithKeysetV2
        )) {
          // Should not reach here
          nodeUids.push(node.uid);
        }
      }).rejects.toThrow(
        'Terminating iterator: found node with empty keyset field \'_id\''
      );
    });

    test('query with invalid operation', async () => {
      const faros = new FarosClient({
        url: 'https://prod.api.faros.ai',
        apiKey: 'apiKey',
      });

      const query = await loadQueryFile('mutation.gql');
      expect(() => faros.nodeIterable('graph', query)).toThrow(/invalid query/);
    });
  });
});
