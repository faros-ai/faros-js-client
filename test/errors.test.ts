import {VError, WError} from 'verror';

import * as sut from '../src/errors';

describe('errors', () => {
  function createAxiosError(message: string, cause?: Error): any {
    const error: any = new VError({cause}, message);
    error.isAxiosError = true;
    error.request = {
      url: '/go',
      method: 'GET',
      headers: {Authorization: 'secret'},
    };
    error.config = {baseURL: 'http://test.me'};
    error.response = {status: 500, data: 'data'};
    return error;
  }

  test('wraps the cause unchanged', () => {
    const cause = new Error('cause');
    expect(sut.wrapApiError(cause, 'message')).toEqual(
      new WError(cause, 'message')
    );
  });

  test('wraps the non-error without drama', () => {
    const cause: any = {name: 'not-an-error'};
    expect(sut.wrapApiError(cause, 'message')).toEqual(
      new WError(Error(JSON.stringify(cause)), 'message')
    );
  });

  test('includes info field for axios error', () => {
    const error = createAxiosError('message1');
    const wrappedError: any = sut.wrapApiError(error, 'message');
    expect(wrappedError.message).toMatch(
      /message: API responded with status 500: data/
    );
    expect((wrappedError as any).request).toBeUndefined();
    expect((wrappedError as any).response).toBeUndefined();
    expect((wrappedError as any).config).toBeUndefined();
    const info = VError.info(wrappedError);
    expect(info.req.method).toEqual('GET');
    expect(info.req.url).toEqual('/go');
    expect(info.req.baseUrl).toEqual('http://test.me');
    expect(info.res.status).toEqual(500);
    expect(info.res.data).toEqual('data');
  });

  test('includes info field for nested axios error', () => {
    const cause = createAxiosError('cause');
    const error = new VError(cause, 'error');
    const wrappedError: any = sut.wrapApiError(error, 'message');
    expect(wrappedError.message).toBe('message');
    const wrappedCause = VError.cause(wrappedError);
    expect(wrappedCause).not.toBeUndefined();
    expect(wrappedCause?.message).toBe('error: cause');
    expect(VError.cause(wrappedCause!)?.message).toBe(
      'API responded with status 500: data'
    );
    expect((wrappedCause as any).request).toBeUndefined();
    expect((wrappedCause as any).response).toBeUndefined();
    expect((wrappedCause as any).config).toBeUndefined();
    const info = VError.info(wrappedCause!);
    expect(info.req.method).toEqual('GET');
    expect(info.req.url).toEqual('/go');
    expect(info.req.baseUrl).toEqual('http://test.me');
    expect(info.res.status).toEqual(500);
    expect(info.res.data).toEqual('data');
  });
});
