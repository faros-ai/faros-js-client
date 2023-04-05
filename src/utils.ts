import {Duration} from 'luxon';
import VError from 'verror';
import {
  ConflictClause,
  Mutation,
  MutationObject,
  MutationReference,
} from './types';
import {EnumType, jsonToGraphQLQuery} from 'json-to-graphql-query';

export class Utils {
  static urlWithoutTrailingSlashes(url: string): string {
    return new URL(url).toString().replace(/\/{1,10}$/, '');
  }

  static parseInteger(value: string): number {
    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue) || isNaN(Number(value))) {
      throw new VError('Invalid integer: %s', value);
    }
    return parsedValue;
  }

  static parseIntegerPositive(value: string): number {
    const parsedValue = Utils.parseInteger(value);
    if (parsedValue <= 0) {
      throw new VError('Not positive: %s', value);
    }
    return parsedValue;
  }

  static parseIntegerWithDefault(
    // eslint-disable-next-line max-len
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    value: any,
    defaultValue: number,
    toPositive?: boolean
  ): number {
    if (!value) {
      return defaultValue;
    }
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      if (toPositive) {
        return Utils.parseIntegerPositive(value);
      }
      return Utils.parseInteger(value);
    }
    throw new VError('Invalid integer: %s', value);
  }

  static parseFloatFixedPoint(value: string, fractionDigits?: number): number {
    const parsedValue = parseFloat(value);
    if (isNaN(parsedValue) || isNaN(Number(value))) {
      throw new VError('Invalid float: %s', value);
    }
    return fractionDigits !== undefined && fractionDigits !== null
      ? parseFloat(parsedValue.toFixed(fractionDigits))
      : parsedValue;
  }

  static parseFloatFixedPointPositive(
    value: string,
    fractionDigits?: number
  ): number {
    const parsedValue = Utils.parseFloatFixedPoint(value, fractionDigits);
    if (parsedValue <= 0) {
      throw new VError('Not positive float: %s', value);
    }
    return parsedValue;
  }

  static toStringList(value?: string | string[]): string[] {
    if (!value) {
      return [];
    }
    if (Array.isArray(value)) {
      return value;
    }
    return value
      .split(',')
      .map((x) => x.trim())
      .filter((p) => p);
  }

  static toDate(val: Date | string | number | undefined): Date | undefined {
    if (typeof val === 'number') {
      return new Date(val);
    }
    if (!val) {
      return undefined;
    }
    return new Date(val);
  }

  /**
   * Parses a string into a duration. The string must either be a number (e.g.
   * '123', '1000') which will be interpreted as milliseconds, or a number
   * suffixed by a common unit (e.g. '10 seconds', '1 minute', '2 hours').
   */
  static toDuration(val: number | string): Duration {
    if (typeof val == 'number') {
      return Duration.fromMillis(val);
    }
    const parts = val.split(' ').filter((s) => s);
    if (!parts.length || parts.length > 2 || !/^[0-9]+$/.test(parts[0])) {
      throw new VError('invalid duration string: %j', val);
    }
    const num = parseInt(parts[0], 10);
    let unit = parts.length === 1 ? 'milliseconds' : parts[1];
    if (!unit.endsWith('s')) {
      unit += 's';
    }
    return Duration.fromObject({[unit]: num});
  }
}

export class QueryBuilder {
  constructor(private readonly origin: string) {}

  /**
   * Creates an upsert mutation.
   * @param model   The Faros model
   * @param obj     The object to convert
   * @param mask    The column mask of what to update on conflict
   * @returns       The upsert mutation
   */
  upsert(model: string, obj: any, mask?: string[]): Mutation {
    const mutationObj = this.mutationObj(model, obj, mask, false);
    return {
      mutation: {
        [`insert_${model}_one`]: {__args: mutationObj, id: true},
      },
    };
  }

  /**
   * Create a mutation object with a conflict clause from mask if provided.
   * @param model   The Faros model
   * @param obj     The object to convert
   * @param mask    The field mask determining what to update on conflict
   * @param nested  Whether the model is nested within another mutation
   * @returns       The mutation object
   */
  mutationObj(
    model: string,
    obj: any,
    mask: string[] = [],
    nested = true
  ): MutationObject {
    const cleanObj = removeUndefinedProperties(obj);
    cleanObj.origin = this.origin;
    mask.push('origin');
    return {
      [nested ? 'data' : 'object']: cleanObj,
      on_conflict: this.createConflictClause(model, mask),
    };
  }

  /**
   * Creates a reference to an object. The object is unchanged if it exists.
   * If the object does not exist already, then a phantom node is created
   * using the models key fields and null origin.
   * @param model   The Faros model
   * @param objKey  An object containing the model's key fields
   * @returns       The mutation reference
   */
  mutationRef(model: string, objKey: any): MutationReference {
    return {
      data: objKey,
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

export function removeUndefinedProperties(object: any): any {
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
