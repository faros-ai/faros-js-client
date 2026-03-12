import {EnumType, jsonToGraphQLQuery} from 'json-to-graphql-query';
import {isNil} from 'lodash';

import {
  ConflictClause,
  DeleteMutationObject,
  Mutation,
  UpsertMutationObject,
} from './types';

type MutationFieldValue =
  | string
  | number
  | boolean
  | any[]
  | {category: string; detail?: string | null}
  | {[field: string]: string | number | boolean}
  | Ref
  | undefined
  | null;

interface MutationFields {
  [field: string]: MutationFieldValue;
}

interface Conflict {
  constraint: string;
  update_columns: string[];
}

export interface FarosModel {
  [modelName: string]: MutationFields;
}

export class Ref {
  constructor(readonly model?: FarosModel) {}
}

export class QueryBuilder {
  constructor(private readonly origin: string) {}

  /**
   * Creates an upsert mutation for the provided Faros model.
   * @param model   The Faros model
   * @param conflict Override the default conflict clause
   * @returns       The upsert mutation
   */
  upsert(model: FarosModel, conflict?: Conflict): Mutation {
    const mutationObj = this.upsertMutationObj({model, ref: false, conflict});
    const modelName = Object.keys(model)[0];
    return {
      mutation: {
        [`insert_${modelName}_one`]: {__args: mutationObj, id: true},
      },
    };
  }

  delete(model: FarosModel): Mutation {
    const deleteObj = this.deleteMutationObj(model);
    const modelName = Object.keys(model)[0];
    return {
      mutation: {
        [`delete_${modelName}`]: {
          __args: deleteObj,
          returning: {
            id: true,
          },
        },
      },
    };
  }

  /**
   * Creates a Ref that can be used in another Faros Model.
   */
  ref(model?: FarosModel): Ref {
    return new Ref(model);
  }

  /**
   * Creates a mutation object that will update every field of the Faros Model.
   * If the model contains fields that reference another
   * model, those fields will be recursively turned into MutationReferences.
   * @param model   The Faros model
   * @param ref     If the mutationObj should be a reference
   * @returns       The mutation object
   */
  private upsertMutationObj(args: {
    model: FarosModel;
    conflict?: Conflict;
    ref?: boolean;
  }): UpsertMutationObject {
    const {model, conflict} = args;
    const ref = args.ref ?? false;

    const [modelName, fields] = Object.entries(model)[0];
    const mutObj: any = {};
    const mask = ['refreshedAt'];

    for (const [k, v] of Object.entries(fields ?? {})) {
      let maskKey = k;
      if (isNil(v)) {
        mutObj[k] = null;
      } else if (v instanceof Ref) {
        if (v.model) {
          mutObj[k] = this.upsertMutationObj({model: v.model, ref: true});
        } else {
          mutObj[k] = null;
        }
        // ref's key should be suffixed with Id for onConflict field
        maskKey += 'Id';
      } else {
        mutObj[k] = Array.isArray(v) ? arrayLiteral(v) : v;
      }
      if (!ref) {
        mask.push(maskKey);
      }
    }

    if (!ref) {
      mutObj.origin = this.origin;
      conflict?.update_columns?.push('origin');
      mask.push('origin');
    }

    const defaultConflict = {
      constraint: `${modelName}_pkey`,
      update_columns: mask,
    };

    return {
      [!ref ? 'object' : 'data']: mutObj,
      on_conflict: this.createConflictClause(conflict ?? defaultConflict),
    };
  }

  /**
   * Creates a delete mutation object that will create _eq keys for every field
   * for the Faros Model.
   *
   * @param model   The Faros model
   * @param ref     If the DeleteMutationObject is a reference
   * @returns       The mutation object
   */
  private deleteMutationObj(
    model: FarosModel,
    ref = false
  ): DeleteMutationObject {
    const fields = Object.values(model)[0];
    const mutObj: any = {};

    for (const [k, v] of Object.entries(fields ?? {})) {
      if (isNil(v)) {
        mutObj[k] = null;
      } else if (v instanceof Ref) {
        if (v.model) {
          mutObj[k] = this.deleteMutationObj(v.model, true);
        } else {
          mutObj[k + 'Id'] = {_is_null: true};
        }
      } else {
        const value = Array.isArray(v) ? arrayLiteral(v) : v;
        mutObj[k] = {_eq: value};
      }
    }

    return !ref ? {where: mutObj} : mutObj;
  }

  private createConflictClause(conflict: Conflict): ConflictClause {
    return {
      constraint: new EnumType(conflict.constraint),
      update_columns: conflict.update_columns.map((c) => new EnumType(c)),
    };
  }
}

/**
 * Convert string arrays into postgres literal array.
 * Leave non-string arrays untouched.
 */
export function arrayLiteral(arr: any[]): string | object {
  for (const item of arr) {
    if (typeof item !== 'string') {
      return arr;
    }
  }
  return `{${arr
    .map((s) => {
      const pre = s.startsWith('"') ? '' : '"';
      const suf = s.endsWith('"') ? '' : '"';
      return `${pre}${s}${suf}`;
    })
    .join(',')}}`;
}

export function mask(object: any): string[] {
  return Object.keys(object);
}

/**
 * Constructs a gql query from an array of json mutations.
 * Insert mutations targeting the same model (with matching on_conflict)
 * are grouped into bulk inserts. For example:
 *
 *   mutation {
 *     m0: insert_cicd_Artifact(objects: [{uid: "u1b"}, {uid: "u2b"}], on_conflict: {...}) {
 *       affected_rows
 *     }
 *   }
 *
 * Non-insert mutations (e.g. deletes) are kept as individual operations.
 * Aliases (m0, m1, ...) are used via the __aliasFor directive.
 *
 * @return batch gql mutation or undefined if the input is undefined, empty
 * or doesn't contain any mutations.
 */
export function batchMutation(mutations: Mutation[]): string | undefined {
  if (mutations.length) {
    const queryObj: any = {};

    // Group insert_*_one mutations by type + on_conflict for bulk inserts
    const insertGroups = new Map<
      string,
      {bulkType: string; objects: any[]; onConflict: any}
    >();
    const nonInsertMutations: {queryType: string; queryBody: any}[] = [];

    for (const query of mutations) {
      if (!query.mutation) continue;
      const queryType = Object.keys(query.mutation)[0];
      const queryBody = query.mutation[queryType];

      if (queryType.startsWith('insert_') && queryType.endsWith('_one')) {
        const bulkType = queryType.slice(0, -4); // strip '_one'
        const onConflict = queryBody.__args?.on_conflict;
        const groupKey = `${bulkType}:${JSON.stringify(onConflict)}`;

        if (!insertGroups.has(groupKey)) {
          insertGroups.set(groupKey, {bulkType, objects: [], onConflict});
        }
        insertGroups.get(groupKey)!.objects.push(queryBody.__args.object);
      } else {
        nonInsertMutations.push({queryType, queryBody});
      }
    }

    let aliasIdx = 0;

    // Emit grouped bulk inserts
    for (const {bulkType, objects, onConflict} of insertGroups.values()) {
      const args: any = {objects};
      if (onConflict) {
        args.on_conflict = onConflict;
      }
      queryObj[`m${aliasIdx++}`] = {
        __aliasFor: bulkType,
        __args: args,
        affected_rows: true,
      };
    }

    // Emit non-insert mutations as-is
    for (const {queryType, queryBody} of nonInsertMutations) {
      queryObj[`m${aliasIdx++}`] = {
        __aliasFor: queryType,
        ...queryBody,
      };
    }

    if (Object.keys(queryObj).length > 0) {
      return jsonToGraphQLQuery({mutation: queryObj});
    }
  }
  return undefined;
}
