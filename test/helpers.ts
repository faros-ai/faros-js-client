import fs from 'fs-extra';
import * as gql from 'graphql';
import path from 'path';

export const SCHEMA_DIR = path.join(__dirname, 'resources', 'schemas');

// This is a subset of our schema. Make sure to extend if needed
//  when adding tests.
// This schema is NOT a V2 copy of the V1 schema above
export const graphSchemaV2 = gql.buildSchema(
  fs.readFileSync(path.join(SCHEMA_DIR, 'schema-v2.gql'), 'utf-8')
);

export const graphSchemaV2ForPrimaryKeysTest = gql.buildSchema(
  fs.readFileSync(path.join(SCHEMA_DIR, 'v2_schema_for_pk_test.gql'), 'utf-8')
);

export const graphSchemaV2ForForeignKeyExclusionTest = gql.buildSchema(
  fs.readFileSync(
    path.join(SCHEMA_DIR, 'v2_schema_for_fk_exclusion_test.gql'),
    'utf-8'
  )
);

export const graphSchemaV2ForAdapterTest = gql.buildSchema(
  fs.readFileSync(
    path.join(SCHEMA_DIR, 'v2_schema_for_adapter_test.gql'),
    'utf-8'
  )
);

export async function loadQueryFile(name: string): Promise<string> {
  const query = await fs.readFile(
    path.join(__dirname, 'resources', 'queries', name),
    'utf-8'
  );
  return gql.print(gql.parse(query));
}

export async function toArray<T>(it: AsyncIterable<T>): Promise<T[]> {
  const arr: T[] = [];
  for await (const i of it) {
    arr.push(i);
  }
  return arr;
}

export async function* toIterator<T>(
  arr: ReadonlyArray<T>
): AsyncIterableIterator<T> {
  for (const item of arr) {
    yield item;
  }
}
