import {AxiosInstance, AxiosRequestConfig, Method} from 'axios';
import * as gql from 'graphql';
import {get as traverse, isEmpty, unset} from 'lodash';
import pino, {Logger} from 'pino';
import {Dictionary} from 'ts-essentials';
import {promisify} from 'util';
import * as zlib from 'zlib';

import {makeAxiosInstanceWithRetry} from './axios';
import {wrapApiError} from './errors';
import {paginatedQueryV2} from './graphql/graphql';
import {batchMutation} from './graphql/query-builder';
import {Mutation, Schema} from './graphql/types';
import {
  Account,
  FarosClientConfig,
  GraphVersion,
  Location,
  NamedQuery,
  Phantom,
  SecretName,
  UpdateAccount,
  UpdateWebhookEventStatus,
  WebhookEvent,
} from './types';
import {Utils} from './utils';

const gzip = promisify(zlib.gzip);

export const DEFAULT_AXIOS_CONFIG: AxiosRequestConfig = {timeout: 60000};

export const GRAPH_VERSION_HEADER = 'x-faros-graph-version';

/** Faros API client **/
export class FarosClient {
  private readonly api: AxiosInstance;
  readonly phantoms: Phantom;

  constructor(
    private readonly cfg: FarosClientConfig,
    readonly logger: Logger<string> = pino({name: 'faros-client'}),
    private readonly axiosConfig: AxiosRequestConfig = DEFAULT_AXIOS_CONFIG
  ) {
    const url = Utils.urlWithoutTrailingSlashes(cfg.url);

    this.api = makeAxiosInstanceWithRetry(
      {
        ...axiosConfig,
        baseURL: url,
        headers: {
          ...axiosConfig?.headers,
          authorization: cfg.apiKey,
          [GRAPH_VERSION_HEADER]: GraphVersion.V2,
        },
        maxBodyLength: Infinity, // rely on server to enforce request body size
        maxContentLength: Infinity, // accept any response size
      },
      logger
    );

    this.phantoms = cfg.phantoms || Phantom.IncludeNestedOnly;
  }

  copy(
    cfg?: Partial<FarosClientConfig>,
    logger?: Logger<string>,
    axiosConfig?: AxiosRequestConfig
  ): FarosClient {
    return new FarosClient(
      {
        ...this.cfg,
        ...cfg,
      },
      logger ?? this.logger,
      {
        ...this.axiosConfig,
        ...axiosConfig,
      }
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

  async secretExists(name: string, group?: string): Promise<boolean> {
    try {
      const params = group ? {group} : undefined;
      const res = await this.api.get(`/secrets/${name}`, {params});
      return res.status === 200;
    } catch (err: any) {
      if (err.response?.status === 404) {
        return false;
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

  async createGraph(graph: string): Promise<void> {
    try {
      await this.api.put(`/graphs/${graph}`);
    } catch (err: any) {
      throw wrapApiError(err, `failed to create graph: ${graph}`);
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

  queryParameters(): Dictionary<any> {
    return {
      phantoms: this.phantoms,
    };
  }

  private async doGql(
    graph: string,
    query: string,
    variables?: any
  ): Promise<any> {
    try {
      let req: any = variables ? {query, variables} : {query};
      let doCompression = Buffer.byteLength(query, 'utf8') > 10 * 1024; // 10KB
      if (doCompression) {
        try {
          const input = Buffer.from(JSON.stringify(req), 'utf8');
          req = await gzip(input);
          this.logger.debug(
            `Compressed graphql request from ${input.length} ` +
              `to ${req.length} bytes`
          );
        } catch (e) {
          // gzip failed, send uncompressed
          this.logger.warn(e, 'failed to compress graphql request');
          doCompression = false;
        }
      }
      const params = this.queryParameters();
      const headers: any = {};
      if (doCompression) {
        headers['content-encoding'] = 'gzip';
        headers['content-type'] = 'application/json';
      }
      const {data} = await this.api.post(`/graphs/${graph}/graphql`, req, {
        headers,
        params,
      });
      return data;
    } catch (err: any) {
      throw wrapApiError(err, `unable to query graph: ${graph}`);
    }
  }

  /* returns only the data object of a standard qgl response */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  async gql(graph: string, query: string, variables?: any): Promise<any> {
    const data = await this.doGql(graph, query, variables);
    return data.data;
  }

  async sendMutations(graph: string, mutations: Mutation[]): Promise<any> {
    const gql = batchMutation(mutations);
    if (gql) {
      return await this.gql(graph, gql);
    }
    return undefined;
  }

  /* returns both data (as res.data) and errors (as res.errors) */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  async rawGql(graph: string, query: string, variables?: any): Promise<any> {
    return await this.doGql(graph, query, variables);
  }

  async gqlNoDirectives(
    graph: string,
    rawQuery: string,
    variables?: unknown
  ): Promise<any> {
    const ast = gql.visit(gql.parse(rawQuery), {
      // Strip directives from query. These are not supported.
      Directive() {
        return null;
      },
    });
    const query = gql.print(ast);
    return await this.gql(graph, query, variables);
  }

  async gqlSchema(graph: string): Promise<Schema> {
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

  nodeIterable(
    graph: string,
    rawQuery: string,
    pageSize = 100,
    paginator = paginatedQueryV2,
    args: Map<string, any> = new Map<string, any>()
  ): AsyncIterable<any> {
    const {query, edgesPath, edgeIdPath, pageInfoPath} = paginator(rawQuery);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    if (edgeIdPath?.length) {
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<any> {
          let id = '';
          let hasNextPage = true;
          while (hasNextPage) {
            const data = await self.gqlNoDirectives(graph, query, {
              limit: pageSize,
              id,
              ...Object.fromEntries(args.entries()),
            });
            const edges = traverse(data, edgesPath) || [];
            for (const edge of edges) {
              id = traverse(edge, edgeIdPath);
              unset(edge, edgeIdPath);
              if (!id) {
                return;
              }
              yield edge;
            }
            // break on partial page
            hasNextPage = edges.length === pageSize;
          }
        },
      };
    } else if (isEmpty(pageInfoPath)) {
      // use offset and limit
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<any> {
          let offset = 0;
          let hasNextPage = true;
          while (hasNextPage) {
            const data = await self.gqlNoDirectives(graph, query, {
              limit: pageSize,
              offset,
              ...Object.fromEntries(args.entries()),
            });
            const edges = traverse(data, edgesPath) || [];
            for (const edge of edges) {
              yield edge;
            }
            offset += pageSize;
            // break on partial page
            hasNextPage = edges.length === pageSize;
          }
        },
      };
    }
    // use relay-styled cursors
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<any> {
        let cursor: string | undefined;
        let hasNextPage = true;
        while (hasNextPage) {
          const data = await self.gqlNoDirectives(graph, query, {
            pageSize,
            cursor,
            ...Object.fromEntries(args.entries()),
          });
          const edges = traverse(data, edgesPath) || [];
          for (const edge of edges) {
            yield edge.node;
            cursor = edge.cursor;
          }
          hasNextPage = traverse(data, pageInfoPath)?.hasNextPage ?? false;
        }
      },
    };
  }

  async updateWebhookEventStatus(
    status: UpdateWebhookEventStatus
  ): Promise<void> {
    try {
      await this.api.patch(
        `/webhooks/${status.webhookId}/events/${status.eventId}`,
        {
          status: status.status,
          error: status.error,
        }
      );
    } catch (err: any) {
      throw wrapApiError(
        err,
        `unable to update status for webhook: ${status.webhookId}` +
          `, event: ${status.eventId}`
      );
    }
  }

  async getWebhookEvent(
    webhookId: string,
    eventId: string
  ): Promise<WebhookEvent> {
    try {
      const response = await this.api.get(
        `/webhooks/${webhookId}/events/${eventId}`
      );
      let event = response.data;
      event = {
        ...event,
        createdAt: event.createdAt ? new Date(event.createdAt) : undefined,
        receivedAt: new Date(event.receivedAt),
        updatedAt: new Date(event.updatedAt),
      };
      return event as WebhookEvent;
    } catch (err: any) {
      throw wrapApiError(
        err,
        `unable to retrieve event: ${eventId} for webhook: ${webhookId}`
      );
    }
  }

  /**
   * Generic method for making requests to the Faros API.
   * @param method HTTP request method
   * @param path endpoint path
   * @param data request body
   * @param params request query params
   * @returns response body
   */
  async request<T>(
    method: Method,
    path: string,
    data?: any,
    params?: any
  ): Promise<T> {
    try {
      const response = await this.api.request({
        method,
        url: path,
        data,
        params,
      });
      return response.data;
    } catch (err: any) {
      throw wrapApiError(err, `unable to perform request: ${path}`);
    }
  }

  /**
   * Sets the API key to use for requests.
   * @param apiKey API key to use for requests
   */
  setApiKey(apiKey: string): void {
    this.api.defaults.headers.authorization = apiKey;
  }
}
