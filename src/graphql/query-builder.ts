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
  | {category: string; detail: string}
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
 * The outputted qql mutation might look like:
 *
 *   mutation  {
 *     i1: insert_cicd_Artifact_one(object: {uid: "u1b"}) {
 *       id
 *       refreshedAt
 *     }
 *     i2: insert_cicd_Artifact_one(object: {uid: "u2b"}) {
 *       id
 *       refreshedAt
 *     }
 *   }
 *
 *  Notable here are the i1/i2 aliases.
 *  These are required when multiple operations share the same
 *  name (e.g. insert_cicd_Artifact_one) and are supported in
 *  jsonToGraphQLQuery with __aliasFor directive.
 *
 *  @return batch gql mutation or undefined if the input is undefined, empty
 *  or doesn't contain any mutations.
 */
export function batchMutation(mutations: Mutation[]): string | undefined {
  if (mutations.length) {
    const queryObj: any = {};
    mutations.forEach((query, idx) => {
      if (query.mutation) {
        const queryType = Object.keys(query.mutation)[0];
        const queryBody = query.mutation[queryType];
        queryObj[`m${idx}`] = {
          __aliasFor: queryType,
          ...queryBody,
        };
      }
    });
    if (Object.keys(queryObj).length > 0) {
      return jsonToGraphQLQuery({mutation: queryObj});
    }
  }
  return undefined;
}
