import nock from 'nock';

import {FarosClient, FarosClientConfig, Schema} from '../src';
import {GRAPH_VERSION_HEADER} from '../src/client';
import {Phantom, WebhookEvent, WebhookEventStatus} from '../src/types';

const apiUrl = 'https://test.faros.ai';
const clientConfig = {url: apiUrl, apiKey: 'test-key', useGraphQLV2: false};
const client = new FarosClient(clientConfig);

describe('client', () => {
  test('get tenant', async () => {
    const mock = nock(apiUrl).get('/users/me').reply(200, {tenantId: '1'});
    const res = await client.tenant();
    mock.done();
    expect(res).toBe('1');
  });

  test('get secret', async () => {
    const mock = nock(apiUrl)
      .get('/secrets/top-secret')
      .reply(200, {value: 'ZEKRET'});
    const res = await client.secret('top-secret');
    mock.done();
    expect(res).toBe('ZEKRET');
  });

  test('get secrets', async () => {
    const mock = nock(apiUrl)
      .get('/secrets')
      .reply(200, {
        secrets: [
          {name: 'secret1', group: 'group1'},
          {name: 'secret2', group: 'group2'},
        ],
      });
    const res = await client.secrets();
    mock.done();
    expect(res).toEqual([
      {name: 'secret1', group: 'group1'},
      {name: 'secret2', group: 'group2'},
    ]);
  });

  test('get secrets by group', async () => {
    const mock = nock(apiUrl)
      .get('/secrets?group=mygroup')
      .reply(200, {
        secrets: [{name: 'mysecret', group: 'mygroup'}],
      });
    const res = await client.secrets('mygroup');
    mock.done();
    expect(res).toEqual([{name: 'mysecret', group: 'mygroup'}]);
  });

  test('graph exists', async () => {
    const mock = nock(apiUrl).get('/graphs/g1/statistics').reply(200);
    const res = await client.graphExists('g1');
    mock.done();
    expect(res).toBe(true);
  });

  test('graph does not exist', async () => {
    const mock = nock(apiUrl).get('/graphs/g1/statistics').reply(404);
    const res = await client.graphExists('g1');
    mock.done();
    expect(res).toBe(false);
  });

  test('get models', async () => {
    const mock = nock(apiUrl)
      .get('/graphs/g1/models')
      .reply(200, {
        models: [
          {name: 'model1', key: ['key1A', 'key1B']},
          {name: 'model2', key: ['key2A', 'key2B']},
        ],
      });
    const res = await client.models('g1');
    mock.done();
    expect(res).toEqual([
      {name: 'model1', key: ['key1A', 'key1B']},
      {name: 'model2', key: ['key2A', 'key2B']},
    ]);
  });

  test('get query', async () => {
    const mock = nock(apiUrl)
      .get('/queries/my-query')
      .reply(200, {query: {dataPath: 'a.b.c', query: '{ hello { world } }'}});
    const res = await client.namedQuery('my-query');
    mock.done();
    expect(res).toStrictEqual({
      dataPath: 'a.b.c',
      query: '{ hello { world } }',
    });
  });

  test('get entry schema', async () => {
    const mock = nock(apiUrl)
      .get('/graphs/g1/revisions/entries/schema')
      .reply(200, {schema: []});
    const res = await client.entrySchema('g1');
    mock.done();
    expect(res).toEqual([]);
  });

  test('gql', async () => {
    const query = `{
      tms {
        tasks {
          nodes {
            uid
          }
        }
      }
    }`;

    const mock = nock(apiUrl)
      .post('/graphs/g1/graphql', JSON.stringify({query}))
      .reply(200, {data: {tms: {tasks: {nodes: [{uid: '1'}, {uid: '2'}]}}}});

    const res = await client.gql('g1', query);
    mock.done();
    expect(res).toStrictEqual({
      tms: {tasks: {nodes: [{uid: '1'}, {uid: '2'}]}},
    });
  });

  const gqlSchema: Schema = {
    primaryKeys: {
      cal_Calendar: ['tenant_id', 'graph_name', 'source', 'uid'],
    },
    scalars: {
      cal_Calendar: {
        description: 'String',
      },
    },
    references: {
      cal_Calendar: {
        owner: {
          field: 'cal_User',
          model: 'cal_User',
          foreignKey: 'user',
        },
      },
    },
    backReferences: {
      cal_Calendar: [
        {
          field: 'cal_Events',
          model: 'cal_Event',
        },
      ],
    },
    sortedModelDependencies: ['cal_Calendar'],
    tableNames: ['cal_Calendar'],
  };

  test('gqlSchema', async () => {
    const mock = nock(apiUrl)
      .get('/graphs/foobar/graphql/schema')
      .reply(200, gqlSchema);

    const res = await client.gqlSchema('foobar');
    mock.done();
    expect(res).toStrictEqual(gqlSchema);
  });

  test('use v2 off by default', async () => {
    const mock = nock(apiUrl, {
      badheaders: [GRAPH_VERSION_HEADER],
    })
      .get('/graphs/foobar/graphql/schema')
      .reply(200, gqlSchema);

    await client.gqlSchema('foobar');
    mock.done();
  });

  test('check v2 header value', async () => {
    await expectV2Request(
      {
        url: apiUrl,
        apiKey: 'test-key',
        useGraphQLV2: true,
      },
      true
    );
  });

  async function expectV2Request(
    cfg: FarosClientConfig,
    expected: true | URLSearchParams
  ) {
    expect(cfg.useGraphQLV2).toBeTruthy();
    const mock = nock(apiUrl, {
      reqheaders: {
        // use literal to be sure as variable requires []'s
        'x-faros-graph-version': /v2/i,
      },
    })
      .post('/graphs/foobar/graphql')
      .query(expected)
      .reply(200, {});
    const client = new FarosClient(cfg);
    await client.gql('foobar', 'query { __schema { types { name } } }');
    mock.done();
  }

  test('v2 query parameters - visibility', async () => {
    const expected = new URLSearchParams({
      phantoms: Phantom.IncludeNestedOnly,
      visibility: 'foobar',
    });
    const clientConfig = {
      url: apiUrl,
      apiKey: 'test-key',
      useGraphQLV2: true,
      visibility: 'foobar',
    };
    await expectV2Request(clientConfig, expected);
  });

  test('v2 query parameters - default', async () => {
    const expected = new URLSearchParams({
      phantoms: Phantom.IncludeNestedOnly,
    });
    const clientConfig = {
      url: apiUrl,
      apiKey: 'test-key',
      useGraphQLV2: true,
    };
    await expectV2Request(clientConfig, expected);
  });

  test('v2 query parameters - custom phantoms', async () => {
    const expected = new URLSearchParams({
      phantoms: Phantom.Exclude,
    });
    const clientConfig = {
      url: apiUrl,
      apiKey: 'test-key',
      useGraphQLV2: true,
      phantoms: Phantom.Exclude,
    };
    await expectV2Request(clientConfig, expected);
  });

  test('gql v2 - default', async () => {
    const query = `
      {
        tms_Task {
          uid
        }
      } `;
    const mock = nock(apiUrl)
      .post('/graphs/g1/graphql', JSON.stringify({query}))
      .query({phantoms: Phantom.IncludeNestedOnly})
      .reply(200, {data: {result: 'ok'}});

    const clientConfig = {url: apiUrl, apiKey: 'test-key', useGraphQLV2: true};
    const client = new FarosClient(clientConfig);

    const res = await client.gql('g1', query);
    mock.done();
    expect(res).toEqual({result: 'ok'});
  });

  test('gql with variables', async () => {
    const query = `{
      query ($pageSize: Int = 10, $after: Cursor) {
        tms {
          tasks(first: $pageSize, after: $after) {
            edges {
              node {
                uid
              }
            }
          }
        }
      }
    }`;

    const mock = nock(apiUrl)
      .post(
        '/graphs/g1/graphql',
        JSON.stringify({query, variables: {pageSize: 100, after: 'abc'}})
      )
      .reply(200, {
        data: {tms: {tasks: {edges: [{node: {uid: '1'}}, {node: {uid: '2'}}]}}},
      });

    const res = await client.gql('g1', query, {pageSize: 100, after: 'abc'});
    mock.done();
    expect(res).toStrictEqual({
      tms: {tasks: {edges: [{node: {uid: '1'}}, {node: {uid: '2'}}]}},
    });
  });

  test('introspect', async () => {
    const mock = nock(apiUrl)
      .post('/graphs/g1/graphql')
      .reply(200, {
        data: {
          __schema: {
            queryType: {
              name: 'Query',
            },
            types: [
              {
                kind: 'OBJECT',
                name: 'Query',
                description: 'Root query',
                fields: [],
                interfaces: [],
              },
            ],
            directives: [],
          },
        },
      });

    const res = await client.introspect('g1');
    mock.done();
    expect(res?.getQueryType()?.name).toBe('Query');
  });

  const accountsRes = [
    {
      accountId: 'abc',
      tenantId: 'tenant',
      farosApiKeyId: 'apikey',
      type: 'type',
      mode: null,
      params: {
        graphName: 'graph1',
        pageSize: 100,
        debug: false,
      },
      secretsName: 'secret1',
      scheduleExpression: 'rate(6 hours)',
      executionTimeoutInSecs: 900,
      runtimeVersion: null,
      memorySizeInMbs: 256,
      version: '0.1.0',
      lastModified: '2021-11-11T17:24:26.833492Z',
    },
    {
      accountId: 'def',
      tenantId: 'tenant',
      farosApiKeyId: 'apikey',
      type: 'type',
      mode: null,
      params: {
        graphName: 'graph2',
        pageSize: 100,
        debug: false,
      },
      secretsName: 'group/secret2',
      scheduleExpression: 'rate(6 hours)',
      executionTimeoutInSecs: 900,
      runtimeVersion: null,
      memorySizeInMbs: 256,
      version: '0.1.0',
      lastModified: '2021-11-11T17:24:26.833492Z',
    },
  ];

  test('list accounts', async () => {
    const mock = nock(apiUrl)
      .get('/accounts')
      .reply(200, {accounts: accountsRes});
    const res = await client.accounts();
    mock.done();
    expect(res).toEqual([
      {
        ...accountsRes[0],
        secretsName: undefined,
        secretName: {
          name: 'secret1',
        },
        lastModified: new Date('2021-11-11T17:24:26.833492Z'),
      },
      {
        ...accountsRes[1],
        secretsName: undefined,
        secretName: {
          group: 'group',
          name: 'secret2',
        },
        lastModified: new Date('2021-11-11T17:24:26.833492Z'),
      },
    ]);
  });

  test('list accounts by graph', async () => {
    const mock = nock(apiUrl)
      .get('/accounts')
      .reply(200, {accounts: accountsRes});
    const res = await client.accounts('graph2');
    mock.done();
    expect(res).toEqual([
      {
        ...accountsRes[1],
        secretsName: undefined,
        secretName: {
          group: 'group',
          name: 'secret2',
        },
        lastModified: new Date('2021-11-11T17:24:26.833492Z'),
      },
    ]);
  });

  test('update account', async () => {
    const update = {
      tenantId: 'tenant',
      farosApiKeyId: 'apikey',
      type: 'type',
      mode: null,
      params: {
        graphName: 'graph2',
        pageSize: 100,
        debug: false,
      },
      secretName: {
        name: 'secret1',
      },
      scheduleExpression: 'rate(6 hours)',
      executionTimeoutInSecs: 900,
      runtimeVersion: null,
      memorySizeInMbs: 256,
      version: '0.1.0',
    };
    const mock = nock(apiUrl).put('/accounts/abc', update).reply(200);
    await client.updateAccount({...update, accountId: 'abc'});
    mock.done();
  });

  test('geocode', async () => {
    const locations = ['419 University Ave, Palo Alto, CA 94301'];
    const locationsRes = [
      {
        uid: '419 University Ave, Palo Alto, CA 94301',
        raw: '419 University Ave, Palo Alto, CA 94301',
        address: {
          // eslint-disable-next-line max-len
          uid: 'EjI0MjAgVW5pdmVyc2l0eSBBdmUgIzMzM2EsIFBhbG8gQWx0bywgQ0EgOTQzMDEsIFVTQSIgGh4KFgoUChIJJy30Azm7j4ARbLmzlBtnYb8SBDMzM2E',
          fullAddress: '420 University Ave #333a, Palo Alto, CA 94301, USA',
          street: 'University Avenue',
          houseNumber: '420',
          unit: '333a',
          postalCode: '94301',
          city: 'Palo Alto',
          state: 'California',
          stateCode: 'CA',
          country: 'United States',
          countryCode: 'US',
        },
        coordinates: {lat: 37.4471709, lon: -122.1599896},
      },
    ];

    const mock = nock(apiUrl)
      .post('/geocoding/lookup', JSON.stringify({locations}))
      .reply(200, {locations: locationsRes});

    const res = await client.geocode(...locations);
    mock.done();
    expect(res).toStrictEqual(locationsRes);
  });

  test('update webhook event status', async () => {
    const mock = nock(apiUrl)
      .patch('/webhooks/testWebhookId/events/testEventId')
      .reply(204);

    await client.updateWebhookEventStatus({
      webhookId: 'testWebhookId',
      eventId: 'testEventId',
      status: 'error',
      error: 'error message',
    });
    mock.done();
  });

  test('get webhook event', async () => {
    const webhookId = 'testWebhookId';
    const eventId = 'testEventId';
    const now = new Date();
    const mockReplyEvent: WebhookEvent = {
      id: eventId,
      webhookId,
      event: {
        eventType: 'push',
        commit: {
          sha: '0xdeadbeef',
        },
      },
      name: 'push',
      status: WebhookEventStatus.Pending,
      createdAt: now,
      receivedAt: now,
      updatedAt: now,
    };

    const mock = nock(apiUrl)
      .get(`/webhooks/${webhookId}/events/${eventId}`)
      .reply(200, mockReplyEvent);

    const event = await client.getWebhookEvent(webhookId, eventId);
    expect(event).toEqual(mockReplyEvent);
    mock.done();
  });

  test('generic request', async () => {
    const path = '/prefix/endpoint';
    const body = {foo: 'bar'};
    const responseBody = {result: 'ok'};
    const mock = nock(apiUrl).post(path, body).reply(200, responseBody);
    const response = await client.request('POST', path, body);
    expect(response).toEqual(responseBody);
    mock.done();
  });
});
