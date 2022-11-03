import {AxiosInstance, AxiosRequestConfig} from 'axios';
import * as gql from 'graphql';
import pino, {Logger} from 'pino';

import {makeAxiosInstanceWithRetry} from './axios';
import {wrapApiError} from './errors';
import {Schema} from './graphql/types';
import {
  Account,
  FarosClientConfig,
  NamedQuery,
  SecretName,
  UpdateAccount,
} from './types';
import {Utils} from './utils';

export const DEFAULT_AXIOS_CONFIG: AxiosRequestConfig = {timeout: 60000};

export const GRAPH_VERSION_HEADER = 'x-faros-graph-version';

/** Faros API client **/
export class FarosClient {
  private readonly api: AxiosInstance;

  constructor(
    cfg: FarosClientConfig,
    logger: Logger = pino({name: 'faros-client'}),
    axiosConfig: AxiosRequestConfig = DEFAULT_AXIOS_CONFIG
  ) {
    const url = Utils.urlWithoutTrailingSlashes(cfg.url);

    this.api = makeAxiosInstanceWithRetry(
      {
        ...axiosConfig,
        baseURL: url,
        headers: {
          ...axiosConfig?.headers,
          authorization: cfg.apiKey,
          ...(cfg.useGraphQLV2 && {[GRAPH_VERSION_HEADER]: 'v2'}),
        },
      },
      logger
    );
  }

  async tenant(): Promise<string> {
    try {
      const {data} = await this.api.get('/users/me');
      return data.tenantId;
    } catch (err: any) {
      throw wrapApiError(err, 'unable to get tenant');
    }
  }

  async secret(name: string, group?: string): Promise<string | undefined> {
    try {
      const params = group ? {group} : undefined;
      const {data} = await this.api.get(`/secrets/${name}`, {params});
      return data.value;
    } catch (err: any) {
      if (err.response?.status === 404) {
        return undefined;
      }
      throw wrapApiError(err, `unable to get secret: ${name}`);
    }
  }

  async secrets(group?: string): Promise<ReadonlyArray<SecretName>> {
    try {
      const params = group ? {group} : undefined;
      const {data} = await this.api.get('/secrets', {params});
      return data.secrets;
    } catch (err: any) {
      throw wrapApiError(err, 'unable to list secrets');
    }
  }

  async graphExists(graph: string): Promise<boolean> {
    try {
      await this.api.get(`/graphs/${graph}/statistics`);
      return true;
    } catch (err: any) {
      if (err.response?.status === 404) {
        return false;
      }
      throw wrapApiError(err, `unable to check graph exists: ${graph}`);
    }
  }

  async namedQuery(name: string): Promise<NamedQuery | undefined> {
    try {
      const {data} = await this.api.get(`/queries/${name}`);
      return data.query;
    } catch (err: any) {
      if (err.response?.status === 404) {
        return undefined;
      }
      throw wrapApiError(err, `unable to get query: ${name}`);
    }
  }

  /* returns only the data object of a standard qgl response */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  async gql(graph: string, query: string, variables?: any): Promise<any> {
    try {
      const req = variables ? {query, variables} : {query};
      const {data} = await this.api.post(`/graphs/${graph}/graphql`, req);
      return data.data;
    } catch (err: any) {
      throw wrapApiError(err, `unable to query graph: ${graph}`);
    }
  }

  /* returns both data (as res.data) and errors (as res.errors) */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  async rawGql(graph: string, query: string, variables?: any): Promise<any> {
    try {
      const req = variables ? {query, variables} : {query};
      const {data} = await this.api.post(`/graphs/${graph}/graphql`, req);
      return data;
    } catch (err: any) {
      throw wrapApiError(err, `unable to query graph: ${graph}`);
    }
  }

  async gqlSchema(graph = 'default'): Promise<Schema> {
    try {
      const {data} = await this.api.get(`/graphs/${graph}/graphql/schema`);
      return data;
    } catch (err: any) {
      throw wrapApiError(err, 'unable to load schema');
    }
  }

  async introspect(graph: string): Promise<gql.GraphQLSchema> {
    try {
      const data = await this.gql(graph, gql.getIntrospectionQuery());
      return gql.buildClientSchema(data);
    } catch (err: any) {
      throw wrapApiError(err, `unable to introspect graph: ${graph}`);
    }
  }

  async geocode(...locations: string[]): Promise<ReadonlyArray<Location>> {
    try {
      const req = {locations};
      const {data} = await this.api.post('/geocoding/lookup', req);
      return data.locations;
    } catch (err: any) {
      throw wrapApiError(err, 'unable to geocode locations');
    }
  }

  async accounts(graph?: string): Promise<ReadonlyArray<Account>> {
    try {
      const {
        data: {accounts},
      } = await this.api.get('/accounts');
      if (Array.isArray(accounts)) {
        return accounts
          .filter((a) => (graph ? a.params?.graphName === graph : true))
          .map((a) => {
            let secretName: SecretName;
            if (a.secretsName.includes('/')) {
              const [group, name] = a.secretsName.split('/');
              secretName = {group, name};
            } else {
              secretName = {name: a.secretsName};
            }
            delete a.secretsName;
            return {
              ...a,
              secretName,
              lastModified: new Date(a.lastModified),
            };
          });
      }
      return [];
    } catch (err: any) {
      throw wrapApiError(err, 'unable to list accounts');
    }
  }

  async updateAccount(update: UpdateAccount): Promise<void> {
    try {
      await this.api.put(`/accounts/${update.accountId}`, {
        tenantId: update.tenantId,
        farosApiKeyId: update.farosApiKeyId,
        type: update.type,
        mode: update.mode,
        params: update.params,
        secretName: update.secretName,
        scheduleExpression: update.scheduleExpression,
        executionTimeoutInSecs: update.executionTimeoutInSecs,
        runtimeVersion: update.runtimeVersion,
        memorySizeInMbs: update.memorySizeInMbs,
        version: update.version,
      });
    } catch (err: any) {
      throw wrapApiError(err, `unable to update account: ${update.accountId}`);
    }
  }
}
