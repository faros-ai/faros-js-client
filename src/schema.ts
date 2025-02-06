import {
  GraphQLSchema,
  ObjectTypeDefinitionNode,
  parse,
  printSchema,
  visit,
} from 'graphql';
import {isPlainObject, keyBy, toNumber} from 'lodash';
import {Dictionary} from 'ts-essentials';
import {VError} from 'verror';

/**
 * Utility class for functions that rely on the GraphQL schema of a Faros graph
 */
export class FarosGraphSchema {
  private readonly objectTypeDefs: Dictionary<ObjectTypeDefinitionNode> = {};

  constructor(schema: GraphQLSchema) {
    const printed = printSchema(schema);
    const schemaNode = parse(printed);
    const that = this; // eslint-disable-line @typescript-eslint/no-this-alias
    visit(schemaNode, {
      ObjectTypeDefinition: {
        leave(n): any {
          that.objectTypeDefs[n.name.value] = n;
          return undefined;
        },
      },
    });
  }

  /**
   * Given a JSON record and a Faros model, convert the necessary date fields in
   * the record to: Javascript dates (Timestamp fields) or ISO formatted string
   * (timestamptz fields)
   * Records for models unknown to the schema are returned unchanged
   */
  fixTimestampFields(record: Dictionary<any>, model: string): any {
    if (!isPlainObject(record)) {
      return record;
    }

    if (model.endsWith('__Update')) {
      for (const key of ['mask', 'patch', 'where']) {
        this.fixTimestampFields(record[key], model.replace('__Update', ''));
      }
      return record;
    } else if (model.endsWith('__Deletion')) {
      this.fixTimestampFields(record.where, model.replace('__Deletion', ''));
      return record;
    } else if (model.endsWith('__Upsert')) {
      this.fixTimestampFields(record, model.replace('__Upsert', ''));
      return record;
    }

    const node = this.objectTypeDefs[model];
    if (!node) {
      return record;
    }

    const fieldTypes = keyBy(node.fields, (n) => n.name.value);
    for (const [field, value] of Object.entries(record)) {
      if (!fieldTypes[field] || !value) {
        continue;
      }
      let fieldType = fieldTypes[field].type;
      if (fieldType.kind === 'NonNullType') {
        fieldType = fieldType.type;
      }
      if (fieldType.kind === 'NamedType') {
        if (fieldType.name.value === 'Timestamp') {
          record[field] = toDate(value as string);
        } else if (fieldType.name.value === 'timestamptz') {
          record[field] = toDateAsISOString(value as string);
        } else if (this.objectTypeDefs[fieldType.name.value]) {
          this.fixTimestampFields(value, fieldType.name.value);
        }
      } else if (
        Array.isArray(value) &&
        fieldType.kind === 'ListType' &&
        fieldType.type.kind === 'NamedType'
      ) {
        const listType = fieldType.type.name.value;
        if (this.objectTypeDefs[listType]) {
          value.forEach((item) => this.fixTimestampFields(item, listType));
        }
      } else if (Array.isArray(value) && fieldType.kind === 'ListType') {
        // TODO: support array of arrays and [Timestamp]
        const arrayType =
          fieldType.type.kind === 'NonNullType'
            ? fieldType.type.type
            : fieldType.type;
        if (arrayType.kind === 'NamedType') {
          const listType = arrayType.name.value;
          if (this.objectTypeDefs[listType]) {
            value.forEach((item) => this.fixTimestampFields(item, listType));
          }
        }
      }
    }
    return record;
  }
}

/**
 * Convert JSON value into date. Supports 3 formats:
 * 1. Number, e.g 1603432559976
 * 2. Number as a string, e.g '1603432559976'
 * 3. Timestamp as a string, e.g '2020-10-23T05:55:59.976Z'
 */
function toDate(val: number | string | undefined): Date | undefined {
  if (!val) {
    return undefined;
  }
  if (typeof val === 'number') {
    return new Date(val);
  }
  const dateAsISOString = toDateAsISOString(val);
  if (!dateAsISOString) {
    throw new VError('Invalid date: %s', val);
  }
  return new Date(dateAsISOString);
}

function toDateAsISOString(
  val: number | string | undefined
): string | undefined {
  if (!val) {
    return undefined;
  }
  if (typeof val === 'number') {
    return new Date(val).toISOString();
  }
  try {
    return new Date(val).toISOString();
  } catch {
    try {
      return new Date(toNumber(val)).toISOString();
    } catch {
      throw new VError('Invalid date: %s', val);
    }
  }
}
