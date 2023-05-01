import {EnumType, jsonToGraphQLQuery} from 'json-to-graphql-query';

import {
  ConflictClause,
  Mutation,
  MutationObject,
  MutationReference,
} from '../types';

export interface MutationFields {
  [field: string]: MutationFieldValue;
}

export class Ref {
  constructor(readonly params: RefParams) {}
}

export interface RefParams {
  model: string;
  key: MutationFields;
}

export interface MutationParams extends RefParams {
  body?: MutationFields;
  mask?: string[];
}

interface CategoryDetail {
  category: string;
  detail: string;
}

export type MutationFieldValue = string | number | CategoryDetail | Ref;

export class QueryBuilder {
  constructor(private readonly origin: string) {}

  /**
   * Creates an upsert mutation.
   * @param model   The Faros model
   * @param key     The object's key fields
   * @param body    The object's non key fields
   * @param mask    The column mask of what to update on conflict
   * @returns       The upsert mutation
   */
  upsert(params: MutationParams): Mutation {
    const {model} = params;
    const mutationObj = this.mutationObj(params);
    return {
      mutation: {
        [`insert_${model}_one`]: {__args: mutationObj, id: true},
      },
    };
  }

  /**
   * Creates a Ref with the given RefParams that can be used inside the key
   * or body of an upsert.
   */
  ref(params: RefParams): Ref {
    return new Ref(params);
  }

  /**
   * Create a mutation object that will update every field unless an explicit
   * mask is provided. If the model contains fields that reference another
   * model, those fields will be recursively turned into MutationReferences.
   * @param model   The Faros model
   * @param key     The object's key fields
   * @param body    The object's fields non reference fields
   * @param mask    An explicit column mask for onConflict clause
   * @returns       The mutation object
   */
  private mutationObj(params: MutationParams): MutationObject {
    const {model, key, body, mask} = params;
    const cleanObj = removeUndefinedProperties({...key, ...body} ?? {});

    const mutObj: any = {};
    const fullMask = [];
    for (const [k, v] of Object.entries(cleanObj)) {
      if (v instanceof Ref) {
        mutObj[k] = this.mutationRef(v.params);
        // ref's key should be suffixed with Id for onConflict field
        fullMask.push(`${k}Id`);
      } else {
        mutObj[k] = v;
        fullMask.push(k);
      }
    }

    const conflictMask = mask ?? fullMask;
    mutObj.origin = this.origin;
    conflictMask.push('origin');

    return {
      object: mutObj,
      on_conflict: this.createConflictClause(model, conflictMask),
    };
  }

  /**
   * Creates a reference to an object. The object is unchanged if it exists.
   * If the object does not exist already, then a phantom node is created
   * using the models key fields and null origin. Recursively turns any
   * fields that are references into MutationReferences.
   * @param model   The Faros model
   * @param key     An object containing the model's key fields
   * @returns       The mutation reference
   */
  private mutationRef(params: RefParams): MutationReference {
    const {model, key} = params;

    const mutData: any = {};
    for (const [k, v] of Object.entries(key)) {
      if (v instanceof Ref) {
        mutData[k] = this.mutationRef(v.params);
      } else {
        mutData[k] = v;
      }
    }

    return {
      data: mutData,
      on_conflict: this.createConflictClause(model, ['refreshedAt']),
    };
  }

  private createConflictClause(model: string, mask: string[]): ConflictClause {
    return {
      constraint: new EnumType(`${model}_pkey`),
      update_columns: mask.map((c) => new EnumType(c)),
    };
  }
}

export function mask(object: any): string[] {
  return Object.keys(removeUndefinedProperties(object));
}

function removeUndefinedProperties(object: MutationFields): MutationFields {
  const result = {...object};
  Object.keys(result).forEach(
    (key) => result[key] === undefined && delete result[key]
  );
  return result;
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
