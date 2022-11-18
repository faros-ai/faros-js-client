import {Dictionary} from 'ts-essentials';

export interface Table {
  schema: string;
  name: string;
}

export interface ManualConfiguration {
  manual_configuration: {
    column_mapping: Dictionary<string>;
    remote_table: {
      name: string;
      schema?: string;
    };
  };
}

export interface ObjectForeignKey {
  foreign_key_constraint_on: string;
}

export interface ArrayForeignKey {
  foreign_key_constraint_on: {
    column: string;
    table: Table;
  };
}

export interface ObjectRelationship {
  name: string;
  using: ObjectForeignKey | ManualConfiguration;
}

export interface ArrayRelationship {
  name: string;
  using: ArrayForeignKey | ManualConfiguration;
}

export interface Reference {
  field: string;
  model: string;
}

export interface Schema {
  primaryKeys: Dictionary<string[]>;
  scalars: Dictionary<Dictionary<string>>;
  references: Dictionary<Dictionary<Reference>>;
  backReferences: Dictionary<Reference[]>;
  sortedModelDependencies: ReadonlyArray<string>;
  tableNames: ReadonlyArray<string>;
}

export interface Query {
  readonly name: string;
  readonly gql: string;
}

export interface PathToModel {
  readonly path: ReadonlyArray<string>;
  readonly modelName: string;
}
