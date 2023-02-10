import {ok} from 'assert';
import _, {camelCase} from 'lodash';

import {
  ArrayForeignKey,
  ArrayRelationship,
  ManualConfiguration,
  ObjectForeignKey,
  ObjectRelationship,
  Schema,
} from './types';

export const MULTI_TENANT_COLUMNS = new Set(['tenant_id', 'graph_name']);
const PG_TYPE_REGEX = /\((.*)\)::.*/;

export function foreignKeyForObj(rel: ObjectRelationship): string {
  if (isManualConfiguration(rel.using)) {
    // for object rel, column_mapping contains one entry
    // mapping FK on host table to PK of target table
    const fkToPkMap = rel.using.manual_configuration.column_mapping;
    const fks = Object.keys(fkToPkMap);
    ok(
      fks.length === 1,
      `expected one foreign key in ${JSON.stringify(fkToPkMap)}`
    );
    return fks[0];
  }
  const arrFK = rel.using as ObjectForeignKey;
  const fk = arrFK.foreign_key_constraint_on;
  ok(typeof fk === 'string', `expected object fk on ${JSON.stringify(arrFK)}`);
  return fk;
}

export function foreignKeyForArray(rel: ArrayRelationship): string {
  if (isManualConfiguration(rel.using)) {
    // for array rel, column_mapping contains one entry
    // mapping PK of target table to FK on host table
    const pkToFkMap = rel.using.manual_configuration.column_mapping;
    const pks = Object.keys(pkToFkMap);
    ok(
      pks.length === 1,
      `expected one foreign key in ${JSON.stringify(pkToFkMap)}`
    );
    return _.get(pkToFkMap, pks[0]);
  }
  const arrFK = rel.using as ArrayForeignKey;
  const fk = arrFK.foreign_key_constraint_on?.column;
  ok(fk, `expected array fk on ${JSON.stringify(arrFK)}`);
  return fk;
}

export function foreignKeyForReverseObj(
  rel: ObjectRelationship
): any | undefined {
  if (isManualConfiguration(rel.using)) {
    // for reverse object rel, column_mapping contains one entry
    // mapping literal id to FK on remote table
    return {
      fkCol: rel.using.manual_configuration.column_mapping?.id,
      sourceTable: rel.using.manual_configuration.remote_table?.name
    };
  }
  return undefined;
}

/**
 * Parse elements of primary key from pkey function definition.
 * e.g. pkey(VARIADIC ARRAY[tenant_id, graph_name, source, uid])
 */
export function parsePrimaryKeys(
  exp: string,
  camelCaseFieldNames: boolean,
  includeMultiTenantColumns = false
): string [] {
  return exp
    .replace('pkey(VARIADIC ARRAY[', '')
    .replace('])', '')
    .split(', ')
    .map((col) => col.replace(/"/g, ''))
    .map((col) => {
      // extract col from types e.g. foo::text => foo
      const matches = col.match(PG_TYPE_REGEX);
      return matches ? matches[1] : col;
    })
    .filter((col) =>
      // conditionally filter multi-tenant columns
      includeMultiTenantColumns || !MULTI_TENANT_COLUMNS.has(col))
    .map((col) => (camelCaseFieldNames ? camelCase(col) : col));
}

export function isManualConfiguration(
  using: ManualConfiguration | any
): using is ManualConfiguration {
  return (using as ManualConfiguration).manual_configuration !== undefined;
}

export interface SchemaLoader {
  loadSchema(): Promise<Schema>;
}
