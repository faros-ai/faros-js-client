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
