import {ok} from 'assert';
import axios, {AxiosInstance} from 'axios';
import fs from 'fs-extra';
import {camelCase, find, isEmpty, snakeCase} from 'lodash';
import path from 'path';
import pino, {Logger} from 'pino';
import toposort from 'toposort';
import {assert, Dictionary} from 'ts-essentials';
import {VError} from 'verror';

import {
  foreignKeyForArray,
  foreignKeyForObj,
  foreignKeyForReverseObj,
  isManualConfiguration,
  MULTI_TENANT_COLUMNS,
  parsePrimaryKeys,
  SchemaLoader,
} from './schema';
import {
  ArrayForeignKey,
  ArrayRelationship,
  BackReference,
  ObjectRelationship,
  Reference,
  Schema,
  Table,
} from './types';

// Loads schema from a Hasura api
export class HasuraSchemaLoader implements SchemaLoader {
  private readonly api: AxiosInstance;

  /**
   * Create a schema loader
   * @param url Hasura instance URL
   * @param adminSecret Hasura admin credential
   * @param camelCaseFieldNames where applicable ensure names that will be
   * interpreted as GraphQL fields are camel cased. False by default
   * @param logger
   */
  constructor(
    url: string,
    adminSecret?: string,
    private readonly camelCaseFieldNames = false,
    private readonly logger: Logger = pino({name: 'hasura-schema-loader'}),
  ) {
    this.api = axios.create({
      baseURL: url,
      headers: {
        'X-Hasura-Role': 'admin',
        ...(adminSecret && {'X-Hasura-Admin-Secret': adminSecret}),
      },
    });
  }

  private async fetchDbSource(): Promise<Source> {
    const response = await this.api.post('/v1/metadata', {
      type: 'export_metadata',
      version: 2,
      args: {},
    });
    const sources: Source[] = response.data.metadata.sources;
    const defaultSource = find(sources, (source) => source.name === 'default');
    if (!defaultSource) {
      throw new VError('Faros database not connected to Hasura');
    }
    return defaultSource;
  }

  private async fetchPrimaryKeys(): Promise<Dictionary<string[]>> {
    const response = await this.api.post('/v2/query', {
      type: 'run_sql',
      args: {
        source: 'default',
        sql: await fs.readFile(
          path.join(__dirname, '../../resources/fetch-primary-keys.sql'),
          'utf8'
        ),
        cascade: false,
        read_only: true,
      },
    });
    const result: [string, string][] = response.data.result;
    if (!result) {
      throw new VError('Failed to load primary keys');
    }
    const primaryKeys: Dictionary<string[]> = {};
    result
      .filter((row) => row[0] !== 'table_name')
      .forEach(([table, exp]) => {
        primaryKeys[table] = parsePrimaryKeys(exp, this.camelCaseFieldNames);
      });
    return primaryKeys;
  }

  /**
   * Builds map from sourceTable to map of targetTable by fk column.
   *
   * That is, given:
   *   sourceTable (e.g. cicd_Build)
   *   fk column (e.g. pipeline_id in cicd_Build)
   *   targetTable (e.g. cicd_Pipeline): table.table.name
   *
   * The output, res, can be used as:
   *   res['cicd_Build']['pipeline_id'] => 'cicd_Pipeline'
   */
  static indexFkTargetModels(source: Source): Dictionary<Dictionary<string>> {
    const res: Dictionary<Dictionary<string>> = {};
    for (const table of source.tables) {
      const targetTable: string = table.table.name;
      for (const arrRel of table.array_relationships || []) {
        const fkCol = foreignKeyForArray(arrRel);
        const sourceTable = remoteTableForArray(arrRel);
        ok(sourceTable, `missing source table on ${JSON.stringify(arrRel)}`);
        if (!res[sourceTable]) {
          res[sourceTable] = {};
        }
        res[sourceTable][fkCol] = targetTable;
      }
      // find array relationship represented as reverse object relationships
      for (const objRel of table.object_relationships || []) {
        const reverseObjFk = foreignKeyForReverseObj(objRel);
        if (reverseObjFk) {
          if (!res[reverseObjFk.sourceTable]) {
            res[reverseObjFk.sourceTable] = {};
          }
          res[reverseObjFk.sourceTable][reverseObjFk.fkCol] = targetTable;
        }
      }
    }
    return res;
  }

  async loadSchema(): Promise<Schema> {
    const primaryKeysFromDb = await this.fetchPrimaryKeys();
    const source = await this.fetchDbSource();
    const targetTableByFk = HasuraSchemaLoader.indexFkTargetModels(source);
    const query = await fs.readFile(
      path.join(__dirname, '../../resources/introspection-query.gql'),
      'utf8'
    );
    const response = await this.api.post('/v1/graphql', {query});
    const schema = response.data.data.__schema;
    const tableNames = [];
    const scalars: Dictionary<Dictionary<string>> = {};
    const references: Dictionary<Dictionary<Reference>> = {};
    const backReferences: Dictionary<BackReference[]> = {};
    const primaryKeysFromSchema: Dictionary<string []> = {};
    for (const table of source.tables) {
      const tableName = table.table.name;
      tableNames.push(tableName);
      const type = find(
        schema.types,
        (t) => t.name === tableName && t.kind === 'OBJECT'
      );
      if (!type?.fields) {
        continue;
      }
      const scalarTypes: any[] = type.fields.filter(
        (t: any) => this.unwrapType(t.type).kind === 'SCALAR'
          && t.description !== 'generated'
      );
      const tableScalars: Dictionary<string> = {};
      for (const scalar of scalarTypes) {
        if (!MULTI_TENANT_COLUMNS.has(snakeCase(scalar.name))) {
          tableScalars[scalar.name] = this.unwrapType(scalar.type).name;
        }
      }
      scalars[tableName] = tableScalars;
      if (type.description) {
        try {
          const {primaryKeys} = JSON.parse(type.description);
          if (primaryKeys) {
            assert(Array.isArray(primaryKeys), 'primaryKeys is not an array');
            primaryKeysFromSchema[tableName] = this.camelCaseFieldNames ?
              primaryKeys.map((c) => camelCase(c)) : primaryKeys;
          }
        } catch (e) {
          this.logger.debug(
            `unable to parse ${tableName} description: ${JSON.stringify(e)}`
          );
        }
      }
      const tableReferences: Dictionary<Reference> = {};
      for (const rel of table.object_relationships ?? []) {
        const fk = foreignKeyForObj(rel);
        // skip reverse object relationships
        if (fk === 'id') {
          continue;
        }
        const relFldName = this.camelCaseFieldNames ? camelCase(fk) : fk;
        const relMetadata = {
          field: rel.name,
          model: targetTableByFk[table.table.name][fk],
          foreignKey: relFldName
        };
        // index relation metadata using both FK column and rel.name
        // this is needed for cross-compatibility with CE and SaaS
        // GraphQLClient iterates over fields of records checking this
        // data structure for matches on nested objects.
        // the record contains SDL relationship names like owner or repository
        // in CE, the FK column matches this relationship name
        // in SaaS, the column is irrelevant we need to index by Hasura rel.name
        tableReferences[relFldName] = relMetadata;
        tableReferences[rel.name] = relMetadata;
      }
      references[tableName] = tableReferences;
      backReferences[tableName] = (table.array_relationships ?? []).map(
        (rel) => {
          return {
            field: rel.name,
            model: remoteTableForArray(rel),
          };
        }
      );
      const reverseBackRefs: BackReference[] = [];
      (table.object_relationships ?? []).forEach(
        (rel) => {
          const reverseObjFk = foreignKeyForReverseObj(rel);
          if (reverseObjFk) {
            reverseBackRefs.push({
              field: rel.name,
              model: reverseObjFk.sourceTable,
            });
          }
        },
      );
      backReferences[tableName].push(...reverseBackRefs);
    }
    const modelDeps: [string, string][] = [];
    for (const model of Object.keys(references)) {
      for (const ref of Object.values(references[model])) {
        if (model !== ref.model) {
          modelDeps.push([model, ref.model]);
        }
      }
    }
    const sortedModelDependencies = toposort(modelDeps);
    return {
      primaryKeys: isEmpty(primaryKeysFromSchema) ?
        primaryKeysFromDb : primaryKeysFromSchema,
      scalars,
      references,
      backReferences,
      sortedModelDependencies,
      tableNames,
    };
  }

  // Unwraps type from its wrapping type (non-null and list containers)
  private unwrapType(type: any): any {
    if (type.kind === 'LIST' || type.kind === 'NON_NULL') {
      return this.unwrapType(type.ofType);
    }
    return type;
  }
}

function remoteTableForArray(rel: ArrayRelationship): string {
  if (isManualConfiguration(rel.using)) {
    return rel.using.manual_configuration.remote_table.name;
  }
  const arrFK = rel.using as ArrayForeignKey;
  const table = arrFK.foreign_key_constraint_on?.table?.name;
  ok(table, `expected remote table on ${JSON.stringify(arrFK)}`);
  return table;
}

interface TableWithRelationships {
  table: Table;
  object_relationships: ReadonlyArray<ObjectRelationship>;
  array_relationships: ReadonlyArray<ArrayRelationship>;
}

interface Source {
  name: string;
  kind: string;
  tables: ReadonlyArray<TableWithRelationships>;
  configuration: any;
}
