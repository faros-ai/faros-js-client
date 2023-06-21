import {EnumType, jsonToGraphQLQuery} from 'json-to-graphql-query';

import {ConflictClause, Mutation, MutationObject} from './types';

type MutationFieldValue =
  | string
  | number
  | boolean
  | any[]
  | {category: string; detail: string}
  | Ref
  | undefined
  | null;

interface MutationFields {
  [field: string]: MutationFieldValue;
}

export interface FarosModel {
  [modelName: string]: MutationFields;
}

export class Ref {
  constructor(readonly model: FarosModel) {}
}

export class QueryBuilder {
  constructor(private readonly origin: string) {}

  /**
   * Creates an upsert mutation for the provided Faros model.
   * @param model   The Faros model
   * @returns       The upsert mutation
   */
  upsert(model: FarosModel): Mutation {
    const mutationObj = this.mutationObj(model);
    const modelName = Object.keys(model)[0];
    return {
      mutation: {
        [`insert_${modelName}_one`]: {__args: mutationObj, id: true},
      },
    };
  }

  /**
   * Creates a Ref that can be used in another Faros Model.
   */
  ref(model: FarosModel): Ref {
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
  private mutationObj(model: FarosModel, ref = false): MutationObject {
    const [modelName, fields] = Object.entries(model)[0];
    const mutObj: any = {};
    const mask = ['refreshedAt'];

    for (const [k, v] of Object.entries(fields ?? {})) {
      let maskKey = k;
      if (isNil(v)) {
        mutObj[k] = null;
      } else if (v instanceof Ref) {
        mutObj[k] = this.mutationObj(v.model, true);
        // ref's key should be suffixed with Id for onConflict field
        maskKey += 'Id';
      } else {
        mutObj[k] = Array.isArray(v) ? this.arrayLiteral(v) : v;
      }
      if (!ref) {
        mask.push(maskKey);
      }
    }

    if (!ref) {
      mutObj.origin = this.origin;
      mask.push('origin');
    }

    return {
      [!ref ? 'object' : 'data']: mutObj,
      on_conflict: this.createConflictClause(modelName, mask),
    };
  }

  private createConflictClause(model: string, mask: string[]): ConflictClause {
    return {
      constraint: new EnumType(`${model}_pkey`),
      update_columns: mask.map((c) => new EnumType(c)),
    };
  }

  /**
   * Change string arrays into string literal array.
   * Leave non-string arrays untouched.
   */
  private arrayLiteral(arr: any[]): string | object {
    for (const item of arr) {
      if (typeof item !== 'string') {
        return arr;
      }
    }

    return JSON.stringify(arr)
      .replace('[', '{')
      .replace(']', '}')
      .replace(/"/g, '');
  }
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
