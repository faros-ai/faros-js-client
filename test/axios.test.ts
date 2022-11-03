import nock from 'nock';
import pino from 'pino';

import * as sut from '../src/axios';

const apiUrl = 'https://test.faros.ai';

describe('axios', () => {
  const logger = pino({
    name: 'test',
    transport: {target: 'pino-pretty', options: {levelFirst: true}},
  });

  test('get resource with retry', async () => {
    const mock = nock(apiUrl)
      .get('/hi')
      .reply(502)
      .get('/hi')
      .reply(502)
      .get('/hi')
      .reply(502)
      .get('/hi')
      .reply(200, {tenantId: '1'});
    const client = sut.makeAxiosInstanceWithRetry(
      {baseURL: apiUrl},
      undefined,
      3,
      100
    );
    const res = await client.get('/hi');
    expect(res.status).toBe(200);
    expect(res.data).toStrictEqual({tenantId: '1'});
    mock.done();
  });

  test('post resource with retry', async () => {
    const mock = nock(apiUrl)
      .post('/hi')
      .reply(502)
      .post('/hi')
      .reply(502)
      .post('/hi')
      .reply(502)
      .post('/hi')
      .reply(200, {tenantId: '1'});
    const client = sut.makeAxiosInstanceWithRetry(
      {baseURL: apiUrl},
      undefined,
      3,
      100
    );
    const res = await client.post('/hi');
    expect(res.status).toBe(200);
    expect(res.data).toStrictEqual({tenantId: '1'});
    mock.done();
  });

  test('give up after a retry', async () => {
    const mock = nock(apiUrl).get('/hi').reply(502).get('/hi').reply(404);
    const client = sut.makeAxiosInstanceWithRetry(
      {baseURL: apiUrl},
      logger,
      1,
      100
    );
    await expect(client.get('/hi')).rejects.toThrowError(
      'Request failed with status code 404'
    );
    mock.done();
  });
});
