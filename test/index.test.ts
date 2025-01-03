import axios from 'axios';
import fs from 'fs-extra';
import * as gql from 'graphql';
import path from 'path';

import {FarosClient} from '../src/client';

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

    const query = await loadQueryFile('deployments-v2.gql');
    const nodeUids: any[] = [];
    for await (const node of faros.nodeIterable('graph', query, 1)) {
      nodeUids.push(node.uid);
    }
    expect(nodeUids).toEqual(['deployment1', 'deployment2']);

    const expectedQuery = await loadQueryFile('paginated-deployments-v2.gql');
    expect(mockPost).toHaveBeenNthCalledWith(
      1,
      '/graphs/graph/graphql',
      {
        query: expectedQuery,
        variables: {id: '', limit: 1},
      },
      expect.anything()
    );
    expect(mockPost).toHaveBeenNthCalledWith(
      2,
      '/graphs/graph/graphql',
      {
        query: expectedQuery,
        variables: {id: 'abc', limit: 1},
      },
      expect.anything()
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

  // TODO: The v1 paginator doesn't detect this. Is it a mistake?
  //test('query with multiple selections', async () => {
  //  const faros = new FarosClient({
  //    url: 'https://prod.api.faros.ai',
  //    apiKey: 'apiKey',
  //  });

  //  const query = await loadQueryFile('multiple-selections-v2.gql');
  //  expect(() => faros.nodeIterable('graph', query)).toThrow(/invalid query/);
  //});
});
