import {parsePrimaryKeys} from '../src/graphql/schema';
import * as sut from '../src/utils';

describe('utils', () => {
  test('trim trailing slashes from url', () => {
    const f = sut.Utils.urlWithoutTrailingSlashes;
    expect(() => f('abc')).toThrow('Invalid URL');
    expect(f('https://example.com')).toEqual('https://example.com');
    expect(f('https://example.com/')).toEqual('https://example.com');
    expect(f('https://example.com//')).toEqual('https://example.com');
    expect(f('https://example.com///')).toEqual('https://example.com');
  });
});

describe('parse primary keys', () => {
  test('multi-tenant columns', () => {
    expect(parsePrimaryKeys(
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, source, uid])',
      true,
      false)
    ).toEqual(['source', 'uid']);
    expect(parsePrimaryKeys(
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, source, uid])',
      true,
      true)
    ).toEqual(['tenantId', 'graphName', 'source', 'uid']);
  });
  test('camel case', () => {
    expect(parsePrimaryKeys(
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, source, uid])',
      false,
      true)
    ).toEqual(['tenant_id', 'graph_name', 'source', 'uid']);
  });
  test('remove PG type info', () => {
    expect(parsePrimaryKeys(
      // eslint-disable-next-line max-len
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, (number)::text, repository_id])',
      true)
    ).toEqual(['number', 'repositoryId']);
    expect(parsePrimaryKeys(
      // eslint-disable-next-line max-len
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, (number)::text, repository_id])',
      false)
    ).toEqual(['number', 'repository_id']);
    expect(parsePrimaryKeys(
      // eslint-disable-next-line max-len
      'pkey(VARIADIC ARRAY[tenant_id, graph_name, (lat)::text, (lon)::text])',
      true)
    ).toEqual(['lat', 'lon']);
  });
});
