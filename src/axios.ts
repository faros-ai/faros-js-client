import axios, {AxiosInstance, AxiosRequestConfig} from 'axios';
import axiosRetry, {IAxiosRetryConfig, isRetryableError} from 'axios-retry';
import {Logger} from 'pino';

import {wrapApiError} from './errors';

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
  logger?: Logger,
  retries = DEFAULT_RETRIES,
  delay = DEFAULT_RETRY_DELAY
): AxiosInstance {
  return makeAxiosInstance(config, {
    retries,
    retryCondition: isRetryableError,
    retryDelay: (retryNumber, error) => {
      if (logger) {
        logger.warn(
          wrapApiError(error, `Retry attempt ${retryNumber} of ${retries}`)
        );
      }
      return retryNumber * delay;
    },
  });
}
