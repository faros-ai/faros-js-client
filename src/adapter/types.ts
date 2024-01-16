import * as gql from 'graphql';
import _ from 'lodash';
import VError from 'verror';

/** Typescript needs a hint to correctly narrow readonly arrays */
export function isTypedArray<T>(
  arg: T | ReadonlyArray<T>
): arg is ReadonlyArray<T> {
  return Array.isArray(arg);
}

// Store as a const list so we can do a containment check and
// and also derive a union type of string literals from it
const primitiveTypes = [
  'boolean',
  'double',
  'float',
  'int',
  'long',
  'string',
  'epoch_millis',
  'epoch_millis_string',
] as const;
type PrimitiveType = typeof primitiveTypes[number];

export function isPrimitiveType(val: any): val is PrimitiveType {
  return _.isString(val) && _.includes(primitiveTypes, val);
}

interface PrimitiveListType {readonly entryType: PrimitiveType}

export function isPrimitiveListType(val: any): val is PrimitiveListType {
  return _.isPlainObject(val) && isPrimitiveType(val.entryType);
}

export type LeafValueType = PrimitiveType | PrimitiveListType;

interface LeafValue {
  readonly path: string;
  readonly type: LeafValueType;
}

interface NestedValue {
  readonly path: string;
  readonly nestedPaths: FieldPaths;
}

export function isLeafValue(val: any): val is LeafValue {
  return (
    _.isPlainObject(val) &&
    'path' in val && _.isString(val.path) &&
    'type' in val && (
      isPrimitiveType(val.type) ||
      isPrimitiveListType(val.type)
    )
  );
}

export function isNestedValue(val: any): val is NestedValue {
  return (
    'path' in val && _.isString(val.path) &&
    'nestedPaths' in val && _.isPlainObject(val.nestedPaths)
  );
}

type PathValue = LeafValue | NestedValue;

export interface FieldPaths {
  readonly [path: string | symbol]: PathValue;
}

export function asLeafValueType(
  type: gql.GraphQLType,
  stringifyTimestamps = true
): LeafValueType {
  function asPrimitiveType(type: gql.GraphQLLeafType): PrimitiveType {
    if (gql.isEnumType(type) || type.name === 'String' || type.name === 'ID') {
      return 'string';
    } else if (type.name === 'Boolean') {
      return 'boolean';
    } else if (type.name === 'Double') {
      return 'double';
    } else if (type.name === 'Float') {
      return 'float';
    } else if (type.name === 'Int') {
      return 'int';
    } else if (type.name === 'Long') {
      return 'long';
    } else if (type.name === 'Timestamp') {
      if (stringifyTimestamps) {
        return 'epoch_millis_string';
      }
      return 'epoch_millis';
    }
    throw new VError('unknown GraphQL leaf type: %s', type);
  }

  // Leaf types and lists of (non-null) leaf types are allowed
  if (gql.isListType(type)) {
    type = type.ofType;
    if (gql.isNonNullType(type)) {
      type = type.ofType;
    }
    if (gql.isLeafType(type)) {
      return {entryType: asPrimitiveType(type)};
    }
  } else if (gql.isLeafType(type)) {
    return asPrimitiveType(type);
  }
  throw new VError('unknown GraphQL leaf type: %s', type);
}

// TODO: Merge with graphql.ts. This is implemented differently.
export function isLeafType(type: any): boolean {
  if (gql.isNonNullType(type)) {
    return isLeafType(type.ofType);
  } else if (gql.isListType(type)) {
    type = type.ofType;
    if (gql.isNonNullType(type)) {
      type = type.ofType;
    }
  }
  return gql.isLeafType(type);
}
