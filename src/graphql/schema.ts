import {ok} from 'assert';
import _ from 'lodash';

import {
  ArrayForeignKey,
  ArrayRelationship,
  ManualConfiguration,
  ObjectForeignKey,
  ObjectRelationship,
  Schema,
} from './types';

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

export function isManualConfiguration(
  using: ManualConfiguration | any
): using is ManualConfiguration {
  return (using as ManualConfiguration).manual_configuration !== undefined;
}

export interface SchemaLoader {
  loadSchema(): Promise<Schema>;
}
