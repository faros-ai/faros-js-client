import axios, {AxiosError, AxiosInstance, AxiosRequestConfig} from 'axios';
import axiosRetry, {IAxiosRetryConfig, isRetryableError} from 'axios-retry';
import isRetryAllowed from 'is-retry-allowed';
import {Logger} from 'pino';

import {wrapApiError} from './errors';

type DelayFunction = (
  error: AxiosError<unknown, any>,
  retryNumber?: number
) => number;

export const DEFAULT_RETRIES = 3;
export const DEFAULT_RETRY_DELAY = 1000;

/**
 * A handy function to create an Axios instance
 */
export function makeAxiosInstance(
  config?: AxiosRequestConfig,
  retryConfig?: IAxiosRetryConfig
): AxiosInstance {
  const client = axios.create(config);
  if (!retryConfig || !client?.interceptors) {
    return client;
  }
  axiosRetry(client, retryConfig);
  return client;
}

/**
 * A handy function to create an Axios instance with a retry
 */
export function makeAxiosInstanceWithRetry(
  config?: AxiosRequestConfig,
  logger?: Logger<string>,
  retries = DEFAULT_RETRIES,
  delay: number | DelayFunction = DEFAULT_RETRY_DELAY
): AxiosInstance {
  const isNetworkError = (error: AxiosError<any>): boolean => {
    return (
      !error.response &&
      Boolean(error.code) && // Prevents retrying cancelled requests
      isRetryAllowed(error) // Prevents retrying unsafe errors
    );
  };

  return makeAxiosInstance(config, {
    retries,
    retryCondition: (error) => {
      const isGraphQLEndpoint =
        Boolean(error?.config?.url?.endsWith('graphql')) &&
        error?.config?.method === 'post';
      // Timeouts should be retryable
      // 409 is an edit conflict error, which is retryable for GraphQL endpoints
      return (
        isNetworkError(error) ||
        isRetryableError(error) ||
        (isGraphQLEndpoint && error.response?.status === 409)
      );
    },
    retryDelay: (retryNumber, error) => {
      if (logger) {
        logger.warn(
          wrapApiError(error, `Retry attempt ${retryNumber} of ${retries}`)
        );
      }
      if (typeof delay === 'number') {
        return retryNumber * delay;
      }
      return delay(error, retryNumber);

    },
    shouldResetTimeout: true,
  });
}
