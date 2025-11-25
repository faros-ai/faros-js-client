import {ok} from 'assert';
import * as gql from 'graphql';
import {isScalarType, Kind} from 'graphql';
import {VariableDefinitionNode} from 'graphql/language/ast';
import {jsonToGraphQLQuery, VariableType} from 'json-to-graphql-query';
import _ from 'lodash';
import {Dictionary} from 'ts-essentials';
import {Memoize} from 'typescript-memoize';
import VError from 'verror';

import {FarosClient} from '../client';
import {PathToModel, Query, Reference} from './types';

export type AnyRecord = Record<string, any>;
export type RecordIterable = AsyncOrSyncIterable<AnyRecord>;
type AsyncOrSyncIterable<T> = AsyncIterable<T> | Iterable<T>;

export interface PaginatedQuery {
  readonly query: string;
  readonly modelName: string;
  readonly keysetFields?: string[];
}

export interface FlattenContext {
  readonly fieldTypes: Map<string, gql.GraphQLType>;
  readonly params: Map<string, gql.GraphQLInputType>;
  readonly currentPath: string;
  readonly leafPaths: ReadonlyArray<string>;
  readonly leafToDefault: Map<string, any>;
  readonly depth: number;
  readonly listPaths?: ReadonlyArray<string>;
}

export const NODES = 'nodes';
export const EDGES = 'edges';
export const REFRESHED_AT = 'refreshedAt';

const DEFAULT_DIRECTIVE = 'default';

const ID_FLD = 'id';

// Argument types that pass through pagination
const ALLOWED_ARG_TYPES = new Set(['where', 'filter']);

function invalidQuery(message: string): Error {
  return new Error(`invalid query: ${message}`);
}

export function isObjectListType(type: any): type is gql.GraphQLList<any> {
  return gql.isListType(type) && gql.isObjectType(type.ofType);
}

export function isModelQuery(
  parentType: any,
  type: any
): type is gql.GraphQLObjectType {
  return (
    gql.isObjectType(parentType) &&
    parentType.name.endsWith('Query') &&
    gql.isObjectType(type) &&
    type.name.endsWith('Connection')
  );
}

export type QueryPaginator = (query: string) => PaginatedQuery;

export function paginatedQueryV2(query: string): PaginatedQuery {
  switch (process.env.GRAPHQL_V2_PAGINATOR) {
    case 'offset-limit':
      return paginateWithOffsetLimit(query);
    case 'keyset-v2':
      return paginateWithKeysetV2(query);
    default:
      return paginateWithKeysetV1(query);
  }
}

interface CreateVariableDefinition {
  readonly name: string;
  readonly type: string;
  readonly default?: gql.ConstValueNode;
}

function createOperationDefinition(
  node: gql.OperationDefinitionNode,
  varDefs: CreateVariableDefinition[]
): gql.OperationDefinitionNode {
  const variableDefinitions: VariableDefinitionNode[] = varDefs.map(
    (varDef): VariableDefinitionNode => {
      return {
        kind: Kind.VARIABLE_DEFINITION,
        variable: {
          kind: Kind.VARIABLE,
          name: {kind: Kind.NAME, value: varDef.name},
        },
        type: {
          kind: Kind.NAMED_TYPE,
          name: {kind: Kind.NAME, value: varDef.type},
        },
        ...(varDef.default ? {defaultValue: varDef.default} : {}),
      };
    }
  );
  variableDefinitions.push(...(node.variableDefinitions || []));
  return {
    kind: Kind.OPERATION_DEFINITION,
    name: {kind: Kind.NAME, value: 'paginatedQuery'},
    operation: gql.OperationTypeNode.QUERY,
    variableDefinitions,
    selectionSet: node.selectionSet,
  };
}

function mergeWhereClauses(clauses: any[]): any {
  // extract individual predicates (e.g. {uid: {_eq: true}})
  const fields = _.flatMap(clauses, (c) => _.get(c, 'value'));
  // place within _and clause
  return {
    kind: 'Argument',
    name: {
      kind: 'Name',
      value: 'where',
    },
    value: {
      kind: 'ObjectValue',
      fields: [
        {
          kind: 'ObjectField',
          name: {
            kind: 'Name',
            value: '_and',
          },
          value: {
            kind: 'ListValue',
            values: fields,
          },
        },
      ],
    },
  };
}

/**
 * Paginate queries with where clause and order by on id
 * https://hasura.io/docs/latest/queries/postgres/pagination/#keyset-cursor-based-pagination
 */
export function paginateWithKeysetV1(query: string): PaginatedQuery {
  let modelName: string | undefined;
  const ast = gql.visit(gql.parse(query), {
    Document(node) {
      if (node.definitions.length !== 1) {
        throw invalidQuery(
          'document should contain a single query operation definition'
        );
      }
    },
    OperationDefinition(node) {
      // TODO: Unlike the old v1 paginator, this one doesn't restrict the query
      // to a single model at the root of the query node. Seems like a mistake?
      if (node.operation !== 'query') {
        throw invalidQuery('only query operations are supported');
      }

      // Add pagination variables to query operation
      return createOperationDefinition(node, [
        {
          name: '_id',
          type: 'String',
          default: {kind: gql.Kind.STRING, value: ''},
        },

        {name: '_limit', type: 'Int'},
      ]);
    },
    Field: {
      enter(node) {
        if (modelName) {
          return false;
        }
        modelName = node.name.value;

        const existingWhereArgs =
          node.arguments?.filter((n) => n.name.value === 'where') ?? [];
        let whereArgs: gql.ArgumentNode[] = [
          ...existingWhereArgs,
          {
            kind: gql.Kind.ARGUMENT,
            name: {kind: gql.Kind.NAME, value: 'where'},
            value: {
              kind: gql.Kind.OBJECT,
              fields: [
                {
                  kind: gql.Kind.OBJECT_FIELD,
                  name: {
                    kind: gql.Kind.NAME,
                    value: 'id',
                  },
                  value: {
                    kind: gql.Kind.OBJECT,
                    fields: [
                      {
                        kind: gql.Kind.OBJECT_FIELD,
                        name: {
                          kind: gql.Kind.NAME,
                          value: '_gt',
                        },
                        value: {
                          kind: gql.Kind.VARIABLE,
                          name: {
                            kind: gql.Kind.NAME,
                            value: '_id',
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ];

        if (whereArgs.length > 1) {
          whereArgs = [mergeWhereClauses(whereArgs)];
        }

        return {
          ...node,
          arguments: [
            ...whereArgs,
            {
              kind: 'Argument',
              name: {kind: 'Name', value: 'order_by'},
              value: {
                kind: 'ObjectValue',
                fields: [
                  {
                    kind: 'ObjectField',
                    name: {kind: 'Name', value: 'id'},
                    value: {kind: 'EnumValue', value: 'asc'},
                  },
                ],
              },
            },
            {
              kind: 'Argument',
              name: {kind: 'Name', value: 'limit'},
              value: {
                kind: 'Variable',
                name: {kind: 'Name', value: '_limit'},
              },
            },
          ],
          selectionSet: {
            kind: 'SelectionSet',
            selections: [
              {
                kind: 'Field',
                alias: {kind: 'Name', value: '_id'},
                name: {kind: 'Name', value: 'id'},
              },
              ...(node.selectionSet?.selections ?? []),
            ],
          },
        };
      },
    },
  });

  if (!modelName) {
    throw new VError(
      {info: {query}},
      'Cannot paginate query using keyset v1: Unable to determine model name'
    );
  }

  return {
    query: gql.print(ast),
    modelName,
    keysetFields: ['_id'],
  };
}

/**
 * Paginate queries using timestamp and id fields
 * https://hasura.io/docs/latest/queries/postgres/pagination/#keyset-cursor-based-pagination
 */
export function paginateWithKeysetV2(query: string): PaginatedQuery {
  let modelName: string | undefined;
  const ast = gql.visit(gql.parse(query), {
    Document(node) {
      if (node.definitions.length !== 1) {
        throw invalidQuery(
          'document should contain a single query operation definition'
        );
      }
    },
    OperationDefinition(node) {
      if (node.operation !== 'query') {
        throw invalidQuery('only query operations are supported');
      }

      // Add pagination variables to query operation
      return createOperationDefinition(node, [
        {
          name: '_timestamp',
          type: 'timestamptz',
          default: {kind: gql.Kind.STRING, value: '-infinity'},
        },
        {
          name: '_id',
          type: 'String',
          default: {kind: gql.Kind.STRING, value: ''},
        },
        {name: '_limit', type: 'Int'},
      ]);
    },
    Field: {
      enter(node) {
        if (modelName) {
          // Skip rest of nodes once edges path has been set
          return false;
        }
        modelName = node.name.value;

        let timestampField: string;
        if (modelName.endsWith('_history')) {
          timestampField = 'actionAt';
        } else {
          timestampField = 'refreshedAt';
        }

        const existingWhereArgs =
          node.arguments?.filter((n) => n.name.value === 'where') ?? [];
        let whereArgs: gql.ArgumentNode[] = [
          // where: {
          //   _and: [
          //     {...existingWhereArgs},
          //     {
          //       # This predicate is logically "redundant" with the "_or"
          //       # predicate below, but we add it so the planner can push
          //       # it into the index scan
          //       {timestampField: {_gte: $_timestamp}},
          //       # Break ties using the primary key (id)
          //       _or: [
          //         {timestampField: {_gt: $_timestamp}},
          //         {timestampField: {_eq: $_timestamp}, id: {_gt: $_id}}
          //       ]
          //     }
          //   ]
          // }
          ...existingWhereArgs,
          {
            kind: gql.Kind.ARGUMENT,
            name: {kind: gql.Kind.NAME, value: 'where'},
            value: {
              kind: gql.Kind.OBJECT,
              fields: [
                // {timestampField: {_gte: $_timestamp}}
                {
                  kind: gql.Kind.OBJECT_FIELD,
                  name: {
                    kind: gql.Kind.NAME,
                    value: timestampField,
                  },
                  value: {
                    kind: gql.Kind.OBJECT,
                    fields: [
                      {
                        kind: gql.Kind.OBJECT_FIELD,
                        name: {
                          kind: gql.Kind.NAME,
                          value: '_gte',
                        },
                        value: {
                          kind: gql.Kind.VARIABLE,
                          name: {
                            kind: gql.Kind.NAME,
                            value: '_timestamp',
                          },
                        },
                      },
                    ],
                  },
                },
                // _or: [
                //   {timestampField: {_gt: $_timestamp}},
                //   {timestampField: {_eq: $_timestamp}, id: {_gt: $_id}}
                // ]
                {
                  kind: gql.Kind.OBJECT_FIELD,
                  name: {
                    kind: gql.Kind.NAME,
                    value: '_or',
                  },
                  value: {
                    kind: gql.Kind.LIST,
                    values: [
                      {
                        kind: gql.Kind.OBJECT,
                        fields: [
                          {
                            kind: gql.Kind.OBJECT_FIELD,
                            name: {
                              kind: gql.Kind.NAME,
                              value: timestampField,
                            },
                            value: {
                              kind: gql.Kind.OBJECT,
                              fields: [
                                {
                                  kind: gql.Kind.OBJECT_FIELD,
                                  name: {
                                    kind: gql.Kind.NAME,
                                    value: '_gt',
                                  },
                                  value: {
                                    kind: gql.Kind.VARIABLE,
                                    name: {
                                      kind: gql.Kind.NAME,
                                      value: '_timestamp',
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                      {
                        kind: gql.Kind.OBJECT,
                        fields: [
                          {
                            kind: gql.Kind.OBJECT_FIELD,
                            name: {
                              kind: gql.Kind.NAME,
                              value: timestampField,
                            },
                            value: {
                              kind: gql.Kind.OBJECT,
                              fields: [
                                {
                                  kind: gql.Kind.OBJECT_FIELD,
                                  name: {
                                    kind: gql.Kind.NAME,
                                    value: '_eq',
                                  },
                                  value: {
                                    kind: gql.Kind.VARIABLE,
                                    name: {
                                      kind: gql.Kind.NAME,
                                      value: '_timestamp',
                                    },
                                  },
                                },
                              ],
                            },
                          },
                          {
                            kind: gql.Kind.OBJECT_FIELD,
                            name: {
                              kind: gql.Kind.NAME,
                              value: 'id',
                            },
                            value: {
                              kind: gql.Kind.OBJECT,
                              fields: [
                                {
                                  kind: gql.Kind.OBJECT_FIELD,
                                  name: {
                                    kind: gql.Kind.NAME,
                                    value: '_gt',
                                  },
                                  value: {
                                    kind: gql.Kind.VARIABLE,
                                    name: {
                                      kind: gql.Kind.NAME,
                                      value: '_id',
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          },
        ];

        if (whereArgs.length > 1) {
          whereArgs = [mergeWhereClauses(whereArgs)];
        }

        return {
          ...node,
          arguments: [
            ...whereArgs,
            {
              kind: 'Argument',
              name: {kind: 'Name', value: 'order_by'},
              value: {
                kind: 'ListValue',
                values: [
                  {
                    kind: 'ObjectValue',
                    fields: [
                      {
                        kind: 'ObjectField',
                        name: {kind: 'Name', value: timestampField},
                        value: {kind: 'EnumValue', value: 'asc'},
                      },
                    ],
                  },
                  {
                    kind: 'ObjectValue',
                    fields: [
                      {
                        kind: 'ObjectField',
                        name: {kind: 'Name', value: 'id'},
                        value: {kind: 'EnumValue', value: 'asc'},
                      },
                    ],
                  },
                ],
              },
            },
            {
              kind: 'Argument',
              name: {kind: 'Name', value: 'limit'},
              value: {
                kind: 'Variable',
                name: {kind: 'Name', value: '_limit'},
              },
            },
          ],
          selectionSet: {
            kind: 'SelectionSet',
            selections: [
              {
                kind: 'Field',
                alias: {kind: 'Name', value: '_timestamp'},
                name: {kind: 'Name', value: timestampField},
              },
              {
                kind: 'Field',
                alias: {kind: 'Name', value: '_id'},
                name: {kind: 'Name', value: 'id'},
              },
              ...(node.selectionSet?.selections ?? []),
            ],
          },
        };
      },
    },
  });

  if (!modelName) {
    throw new VError(
      {info: {query}},
      'Cannot paginate query using keyset v2: Unable to determine model name'
    );
  }

  return {
    query: gql.print(ast),
    modelName,
    keysetFields: ['_timestamp', '_id'],
  };
}

export function paginateWithOffsetLimit(query: string): PaginatedQuery {
  let modelName: string | undefined;
  const ast = gql.visit(gql.parse(query), {
    Document(node) {
      if (node.definitions.length !== 1) {
        throw invalidQuery(
          'document should contain a single query operation definition'
        );
      }
    },
    OperationDefinition(node) {
      if (node.operation !== 'query') {
        throw invalidQuery('only query operations are supported');
      }

      // Add pagination variables to query operation
      return createOperationDefinition(node, [
        {name: '_offset', type: 'Int'},
        {name: '_limit', type: 'Int'},
      ]);
    },
    Field: {
      enter(node) {
        if (modelName) {
          return false;
        }
        modelName = node.name.value;

        // copy existing where args
        const existing = (node.arguments ?? []).filter((n) =>
          ALLOWED_ARG_TYPES.has(n.name.value)
        );
        return {
          ...node,
          arguments: [
            ...existing,
            {
              kind: 'Argument',
              name: {kind: 'Name', value: 'offset'},
              value: {
                kind: 'Variable',
                name: {kind: 'Name', value: '_offset'},
              },
            },
            {
              kind: 'Argument',
              name: {kind: 'Name', value: 'limit'},
              value: {
                kind: 'Variable',
                name: {kind: 'Name', value: '_limit'},
              },
            },
            {
              kind: 'Argument',
              name: {kind: 'Name', value: 'order_by'},
              value: {
                kind: 'ObjectValue',
                fields: [
                  {
                    kind: 'ObjectField',
                    name: {kind: 'Name', value: 'refreshedAt'},
                    value: {kind: 'EnumValue', value: 'asc'},
                  },
                  {
                    kind: 'ObjectField',
                    name: {kind: 'Name', value: 'id'},
                    value: {kind: 'EnumValue', value: 'asc'},
                  },
                ],
              },
            },
          ],
        };
      },
    },
  });

  if (!modelName) {
    throw new VError(
      {info: {query}},
      'Cannot paginate query using offset-limit: unable to determine model name'
    );
  }

  return {
    query: gql.print(ast),
    modelName,
  };
}

/**
 * Returns true if this type represents a list of non-leaf objects.
 */
function isListType(type: any): boolean {
  if (gql.isNonNullType(type)) {
    type = type.ofType;
  }
  if (gql.isListType(type)) {
    let ofType = type.ofType;
    // The element type can also be non-null
    if (gql.isNonNullType(ofType)) {
      ofType = ofType.ofType;
    }
    return gql.isObjectType(ofType);
  }
  return false;
}

function isLeafTypeV2(type: any): boolean {
  if (gql.isNonNullType(type)) {
    type = type.ofType;
  }

  if (gql.isListType(type)) {
    let ofType = type.ofType;
    // The element type can also be non-null
    if (gql.isNonNullType(ofType)) {
      ofType = ofType.ofType;
    }
    // A list of object types will be serialized as a list of strings
    return gql.isLeafType(ofType);
  }
  return gql.isLeafType(type);
}

function isJsonbScalar(leaf: gql.GraphQLType): boolean {
  return gql.isScalarType(leaf) && leaf.name.toLowerCase() === 'jsonb';
}

/** Flattens nested nodes returned from a V2 query */
export function flattenV2(
  query: string,
  schema: gql.GraphQLSchema
): FlattenContext {
  const fieldPath: string[] = [];
  const leafPaths: string[] = [];
  const listPaths: string[] = [];
  const pathToDefault = new Map<string, any>();
  const pathToType = new Map<string, gql.GraphQLType>();
  const params = new Map<string, gql.GraphQLInputType>();
  const typeInfo = new gql.TypeInfo(schema);
  const rootPath: string[] = [];
  const jsonArrayPaths: Set<string> = new Set();
  gql.visit(
    gql.parse(query),
    gql.visitWithTypeInfo(typeInfo, {
      VariableDefinition(node): boolean {
        addVariableDefinition(node, schema, params);
        return false;
      },
      Argument(): boolean {
        // Skip arg subtrees
        return false;
      },
      Directive(node) {
        setPathToDefault(node, fieldPath, pathToType, pathToDefault);
        if (node.name.value === 'jsonarray') {
          jsonArrayPaths.add(fieldPath.join('.'));
        }
      },
      Field: {
        enter(node): boolean | void {
          const name = node.alias?.value ?? node.name.value;
          fieldPath.push(name);
          const type = typeInfo.getType();
          if (!rootPath.length) {
            rootPath.push(...fieldPath);
            if (!type) {
              throw new VError('invalid type \'%s\'', name);
            }
          }
          if (isListType(type)) {
            const listPath = fieldPath.join('.');
            listPaths.push(listPath);
          }
          if (isLeafTypeV2(type)) {
            const leafPath = fieldPath.join('.');
            const gqlType = unwrapType(type);
            if (!gqlType) {
              throw new VError(
                'cannot unwrap type \'%s\' of field \'%s\'',
                type,
                leafPath
              );
            }
            // use field description to determine if the jsonb field is an array
            if (
              isScalarType(gqlType) &&
              gqlType.name === 'jsonb' &&
              typeInfo.getFieldDef()?.description === 'array'
            ) {
              jsonArrayPaths.add(leafPath);
            }
            leafPaths.push(leafPath);
            pathToType.set(leafPath, gqlType);
            if (node.selectionSet?.selections?.length) {
              // Returning false bypasses call to leave()
              fieldPath.pop();
              return false;
            }
          }
          return undefined;
        },
        leave(): void {
          fieldPath.pop();
        },
      },
      FragmentDefinition(): void {
        throw new VError('fragments are not supported');
      },
      FragmentSpread(): void {
        throw new VError('fragments are not supported');
      },
    })
  );

  // Verify names won't collide once flattened
  const fieldTypes = new Map<string, gql.GraphQLType>();
  const leafToPath = new Map<string, string>();
  const leafToDefault = new Map<string, any>();
  for (const path of leafPaths) {
    const name = fieldName(path);
    if (leafToPath.has(name)) {
      const otherPath = leafToPath.get(name);
      throw new VError(
        'fields \'%s\' and \'%s\' will both map to the same name: ' +
          '\'%s\'. use field aliases to prevent collision.',
        path,
        otherPath,
        name
      );
    }
    leafToPath.set(name, path);
    leafToDefault.set(name, pathToDefault.get(path));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    let leafType = pathToType.get(path)!;
    if (jsonArrayPaths.has(path) && isJsonbScalar(leafType)) {
      leafType = new gql.GraphQLList(leafType);
    }
    fieldTypes.set(name, leafType);
  }

  return {
    fieldTypes,
    params,
    currentPath: rootPath.join('.'),
    leafToDefault,
    leafPaths,
    depth: 0,
    listPaths,
  };
}

/** Unwrap types from their non-null and list containers */
function unwrapType(type: any): gql.GraphQLType | undefined {
  if (gql.isNonNullType(type)) {
    type = type.ofType;
  }

  if (gql.isLeafType(type)) {
    return type;
  } else if (gql.isListType(type)) {
    let ofType = type.ofType;
    if (gql.isNonNullType(ofType)) {
      ofType = ofType.ofType;
    }
    if (gql.isLeafType(ofType) || gql.isObjectType(ofType)) {
      return new gql.GraphQLList(ofType);
    }
  }
  return undefined;
}

function fieldName(field: string): string {
  return _.snakeCase(_.last(field.split('.')));
}

function addVariableDefinition(
  node: gql.VariableDefinitionNode,
  schema: gql.GraphQLSchema,
  params: Map<string, gql.GraphQLInputType>
): void {
  const nodeType = node.type as gql.NamedTypeNode;
  const type = gql.typeFromAST(schema, nodeType);
  if (gql.isInputType(type)) {
    const unwrapped = unwrapType(type);
    if (!unwrapped) {
      throw new VError(
        'cannot unwrap type \'%s\' of variable \'%s\'',
        type,
        node.variable.name.value
      );
    }
    params.set(node.variable.name.value, unwrapped as gql.GraphQLInputType);
  }
}

function setPathToDefault(
  node: gql.DirectiveNode,
  fieldPath: string[],
  pathToType: Map<string, gql.GraphQLType>,
  pathToDefault: Map<string, any>
): void {
  if (node.name.value !== DEFAULT_DIRECTIVE) {
    return;
  }

  const path = fieldPath.join('.');
  const gqlType = pathToType.get(path);
  const args = node.arguments;
  if (!gql.isScalarType(gqlType)) {
    throw new VError(
      'cannot add default to field \'%s\': defaults are only ' +
        'supported on scalar fields',
      path
    );
  } else if (
    args?.length !== 1 ||
    args[0].name.value !== 'value' ||
    args[0].value.kind !== 'StringValue'
  ) {
    throw new VError(
      'invalid default on field \'%s\': default must contain a single, ' +
        'string valued argument called \'value\'',
      path
    );
  }

  const value = args[0].value.value;
  let defaultValue: any;
  let invalidValue = false;
  switch (gqlType.name) {
    case 'Boolean':
      if (value !== 'true' && value !== 'false') {
        invalidValue = true;
      }
      defaultValue = value === 'true';
      break;
    case 'Float':
    case 'Double':
      defaultValue = parseFloat(value);
      if (!_.isFinite(defaultValue)) {
        invalidValue = true;
      }
      break;
    case 'Int':
    case 'Long':
      if (!_.isInteger(parseFloat(value))) {
        invalidValue = true;
      }
      defaultValue = parseInt(value, 10);
      break;
    case 'ID':
    case 'String':
      defaultValue = value;
      break;
    default:
      throw new VError(
        'cannot set default for field \'%s\' with type: %s',
        path,
        gqlType.name
      );
  }
  if (invalidValue) {
    throw new VError(
      '%s field \'%s\' has invalid default: %s',
      gqlType.name,
      path,
      value
    );
  }
  pathToDefault.set(path, defaultValue);
}

/**
 * Returns an iterable that cross-joins an array of object iterables
 * and merges each output object array into a single object
 */
export async function* crossMerge(
  iters: (AsyncIterable<any> | Iterable<any>)[]
): AsyncIterable<any> {
  if (!iters.length) {
    return;
  }
  const [curr, ...rest] = iters;
  let count1 = 0;
  for await (const item1 of crossMerge(rest)) {
    count1++;
    let count2 = 0;
    for await (const item2 of curr) {
      count2++;
      yield {...item1, ...item2};
    }
    if (!count2) {
      yield item1;
    }
  }
  if (!count1) {
    for await (const item2 of curr) {
      yield item2;
    }
  }
}

/** Flattens an iterable of nested node objects */
export function flattenIterable(
  ctx: FlattenContext,
  nodes: RecordIterable
): AsyncIterable<AnyRecord> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AnyRecord> {
      // Only leaves at the current node depth are assigned values
      // Others leaves are assigned in recursive calls
      const currentLeafPaths = new Map<string, string[]>();
      const nextNodePaths = new Set<string>();
      const sortedAscendingListPaths = Array.from(ctx.listPaths || []).sort(
        (a, b) => a.length - b.length
      );

      function asRelative(leafPath: string): string {
        return ctx.currentPath
          ? leafPath.replace(`${ctx.currentPath}.`, '')
          : leafPath;
      }

      // prefix match on paths sorted ascending gives common
      // nested list where there are lists within lists
      // this prevents multiple recursions on lists within lists
      function nextNestedList(leafPath: string): string | undefined {
        for (const listPath of sortedAscendingListPaths) {
          if (listPath === ctx.currentPath) {
            continue;
          }
          if (leafPath.startsWith(listPath)) {
            return listPath;
          }
        }
        return undefined;
      }

      for (const leafPath of ctx.leafPaths) {
        if (leafPath.startsWith(ctx.currentPath)) {
          const leafName = fieldName(leafPath);
          const relativePath = asRelative(leafPath);
          const relativeParts = relativePath.split('.');
          const nestedList = nextNestedList(leafPath);
          if (nestedList) {
            nextNodePaths.add(asRelative(nestedList));
            continue;
          } else {
            const nodesIndex = relativeParts.indexOf(NODES);
            if (nodesIndex >= 0) {
              const nextPath = relativeParts.slice(0, nodesIndex + 1).join('.');
              nextNodePaths.add(nextPath);
              continue;
            }
          }
          currentLeafPaths.set(leafName, relativeParts);
        }
      }

      for await (const node of nodes || []) {
        const record: any = {};
        for (const [name, parts] of currentLeafPaths) {
          record[name] = _.get(node, parts);
        }

        const nextIters: RecordIterable[] = [[record]];
        for (const nodePath of nextNodePaths) {
          const nextNodes = _.get(node, nodePath.split('.'));
          const nextCurrentPath = `${ctx.currentPath}.${nodePath}`;
          const nextListPaths = sortedAscendingListPaths.filter((p) =>
            p.startsWith(nextCurrentPath)
          );
          const nextCtx = {
            ...ctx,
            currentPath: nextCurrentPath,
            depth: ctx.depth + 1,
            listPaths: nextListPaths,
          };
          nextIters.push(flattenIterable(nextCtx, nextNodes));
        }

        for await (const nextRecord of crossMerge(nextIters)) {
          // Only apply defaults at the end, otherwise they can override
          // actual values in the data
          if (!ctx.depth) {
            for (const [name, defaultValue] of ctx.leafToDefault) {
              nextRecord[name] = nextRecord[name] ?? defaultValue;
            }
          }
          yield nextRecord;
        }
      }
    },
  };
}

export interface Reader {
  execute(args: Map<string, any>): AsyncIterable<AnyRecord>;

  metadata: {
    name: string;
    readonly fields: Map<string, gql.GraphQLType>;
    readonly params: Map<string, gql.GraphQLInputType>;
    readonly modelKeys?: ReadonlyArray<string>;
    readonly incremental: boolean;
  };
}

interface ReaderFromQueryConfig {
  readonly client: FarosClient;
  readonly graph: string;
  readonly graphSchema: gql.GraphQLSchema;
  readonly query: Query;
  readonly pageSize: number;
  readonly incremental?: boolean;
  readonly paginator?: QueryPaginator;
}

export function readerFromQuery(cfg: ReaderFromQueryConfig): Reader {
  const paginator = cfg.paginator ?? paginatedQueryV2;
  const flattenCtx = flattenV2(cfg.query.gql, cfg.graphSchema);
  if (!(flattenCtx.leafPaths.length && flattenCtx.fieldTypes.size)) {
    throw new VError(
      'unable to extract metadata from query %s: %s',
      cfg.query.name,
      cfg.query.gql
    );
  }

  return {
    execute(args: Map<string, any>): AsyncIterable<AnyRecord> {
      const nodes = cfg.client.nodeIterable(
        cfg.graph,
        cfg.query.gql,
        cfg.pageSize,
        paginator,
        args
      );
      return flattenIterable(flattenCtx, nodes);
    },
    metadata: {
      name: cfg.query.name,
      fields: flattenCtx.fieldTypes,
      modelKeys: cfg.incremental ? [ID_FLD] : undefined,
      params: flattenCtx.params,
      incremental: cfg.incremental ?? false,
    },
  };
}

interface NonIncrementalReadersConfig {
  readonly client: FarosClient;
  readonly graph: string;
  readonly graphSchema: gql.GraphQLSchema;
  readonly queries: ReadonlyArray<Query>;
  readonly pageSize: number;
  readonly paginator?: QueryPaginator;
}

export function createNonIncrementalReaders(
  cfg: NonIncrementalReadersConfig
): ReadonlyArray<Reader> {
  return cfg.queries.map((query) =>
    readerFromQuery({
      client: cfg.client,
      graph: cfg.graph,
      graphSchema: cfg.graphSchema,
      query,
      pageSize: cfg.pageSize,
      paginator: cfg.paginator,
      incremental: false,
    })
  );
}

function isV2ModelType(type: any): type is gql.GraphQLObjectType {
  return gql.isObjectType(type)
    ? type.name !== 'graph' && // exclude graph table from extract
        (type.description ?? '').includes('farosModel')
    : false;
}

function isScalar(type: any): boolean {
  const unwrapped = unwrapType(type);
  return (
    gql.isScalarType(unwrapped) ||
    (gql.isListType(unwrapped) && gql.isScalarType(unwrapped.ofType))
  );
}

export function getGraphModels(graphSchema: gql.GraphQLSchema): string[] {
  const models: string[] = [];
  for (const [name, type] of Object.entries(graphSchema.getTypeMap())) {
    if (isV2ModelType(type)) {
      models.push(name);
    }
  }
  return models;
}

interface IncrementalQueryConfig {
  readonly type: gql.GraphQLObjectType;
  readonly resolvedPrimaryKeys?: Dictionary<string>;
  readonly references?: Dictionary<Reference>;
  readonly avoidCollisions?: boolean;
  readonly scalarsOnly?: boolean;
}

/**
 * Creates an incremental query from a model type.
 * The selections will include:
 *  1. All the scalar fields.
 *  2. Nested fragments for all referenced models, selecting their IDs.
 *
 * By default, it aliases referenced models IDs to prevent collisions
 * if flattened.
 * E.g., { id pipeline { id } } => { id pipeline { pipelineId: id } }
 * The avoidCollisions parameter controls this behavior.
 *
 * If resolvedPrimaryKeys is provided, it will use the fully resolved
 * primary key fragment for referenced models instead of the ID field.
 */
export function buildIncrementalQueryV2(cfg: IncrementalQueryConfig): Query {
  const avoidCollisions = cfg.avoidCollisions ?? true;
  const resolvedPrimaryKeys = cfg.resolvedPrimaryKeys ?? {};
  const references = cfg.references ?? {};
  const scalarsOnly = cfg.scalarsOnly ?? false;
  const name = cfg.type.name;
  // add fields and FKs
  const fieldsObj: any = {};
  // add PK
  fieldsObj[ID_FLD] = true;
  for (const fldName of Object.keys(cfg.type.getFields())) {
    const field = cfg.type.getFields()[fldName];
    if (isScalar(field.type)) {
      const reference = references[fldName];
      if (reference) {
        // This is a (scalar) foreign key to a top-level model
        // Check that the non-scalar corresponding foreign key
        // exists and skip from the query selection
        const checkField = cfg.type.getFields()[reference.field];
        ok(
          !_.isNil(checkField),
          `expected ${reference.field} to be a reference field of` +
            ` ${cfg.type.name} (foreign key to ${reference.model})`
        );
      } else {
        fieldsObj[field.name] = true; // arbitrary value here
      }
    } else if (isV2ModelType(field.type) && !scalarsOnly) {
      // this is foreign key to a top-level model.
      // add nested fragment to select id of referenced model
      const fk = resolvedPrimaryKeys[field.type.name] || ID_FLD;
      if (avoidCollisions) {
        let nestedName = `${field.name}Id`;
        // check for collision between nested name and scalars
        if (_.has(cfg.type.getFields(), nestedName)) {
          nestedName = `${field.name}Fk`;
        }
        {
          fieldsObj[field.name] = {
            [`${nestedName}: ${fk}`]: true,
          };
        }
      } else {
        fieldsObj[field.name] = {
          [fk]: true,
        };
      }
    }
  }
  const query = {
    query: {
      __variables: {
        from: 'timestamptz!',
        to: 'timestamptz!',
      },
      [name]: {
        __args: {
          where: {
            refreshedAt: {
              _gte: new VariableType('from'),
              _lt: new VariableType('to'),
            },
          },
        },
        ...fieldsObj,
      },
    },
  };
  return {name, gql: jsonToGraphQLQuery(query)};
}

interface IncrementalReadersConfig {
  readonly client: FarosClient;
  readonly graph: string;
  readonly pageSize: number;
  readonly graphSchema: gql.GraphQLSchema;
  readonly avoidCollisions?: boolean;
  readonly scalarsOnly?: boolean;
}

export function createIncrementalReadersV2(
  cfg: IncrementalReadersConfig
): ReadonlyArray<Reader> {
  const result: Reader[] = createIncrementalQueriesV2({
    graphSchema: cfg.graphSchema,
    avoidCollisions: cfg.avoidCollisions ?? true,
    scalarsOnly: cfg.scalarsOnly ?? false,
  }).map((query) =>
    readerFromQuery({
      client: cfg.client,
      graph: cfg.graph,
      graphSchema: cfg.graphSchema,
      pageSize: cfg.pageSize,
      incremental: true,
      query,
    })
  );
  if (!result.length) {
    throw new VError('failed to create v2 incremental readers');
  }
  return result;
}

export interface IncrementalReaderConfig {
  readonly model: string;
  readonly client: FarosClient;
  readonly graph: string;
  readonly graphSchema: gql.GraphQLSchema;
  readonly pageSize: number;
  readonly paginator?: QueryPaginator;
  readonly avoidCollisions: boolean;
  readonly scalarsOnly: boolean;
}

export function createIncrementalReader(
  cfg: IncrementalReaderConfig
): Reader | undefined {
  const type = cfg.graphSchema.getType(cfg.model);
  if (isV2ModelType(type)) {
    const avoidCollisions = cfg.avoidCollisions ?? true;
    const scalarsOnly = cfg.scalarsOnly ?? false;
    return readerFromQuery({
      client: cfg.client,
      graph: cfg.graph,
      graphSchema: cfg.graphSchema,
      pageSize: cfg.pageSize,
      paginator: cfg.paginator,
      incremental: true,
      query: buildIncrementalQueryV2({
        type,
        avoidCollisions,
        scalarsOnly,
      }),
    });
  }
  return undefined;
}

export interface DataReaderConfig {
  readonly model: string;
  readonly client: FarosClient;
  readonly graph: string;
  readonly graphSchema: gql.GraphQLSchema;
  readonly pageSize: number;
  readonly paginator?: QueryPaginator;
}

export function createDataReader(cfg: DataReaderConfig): Reader | undefined {
  return createIncrementalReader({
    client: cfg.client,
    graph: cfg.graph,
    graphSchema: cfg.graphSchema,
    model: cfg.model,
    pageSize: cfg.pageSize,
    paginator: cfg.paginator,
    avoidCollisions: false,
    scalarsOnly: true,
  });
}

export interface DeleteReaderConfig {
  readonly model: string;
  readonly client: FarosClient;
  readonly graph: string;
  readonly graphSchema: gql.GraphQLSchema;
  readonly pageSize: number;
  readonly paginator?: QueryPaginator;
}

export function createDeleteReader(
  cfg: DeleteReaderConfig
): Reader | undefined {
  const type = cfg.graphSchema.getType(cfg.model);
  if (!isV2ModelType(type)) {
    return undefined;
  }

  const deleteQuery = `
    query delete($from: timestamptz!, $to: timestamptz!) {
      ${cfg.model}_history(where: {_and: [
        {action: {_eq: "delete"}},
        {actionAt: {_gte: $from, _lt: $to}}
      ]}) {
        id
        actionAt
      }
    }`;
  const [deleteReader] = createNonIncrementalReaders({
    client: cfg.client,
    graph: cfg.graph,
    pageSize: cfg.pageSize,
    paginator: cfg.paginator,
    graphSchema: cfg.graphSchema,
    queries: [{gql: deleteQuery, name: cfg.model}],
  });
  return deleteReader;
}

interface IncrementalQueriesConfig {
  readonly graphSchema: gql.GraphQLSchema;
  readonly primaryKeys?: Dictionary<ReadonlyArray<string>>;
  readonly references?: Dictionary<Dictionary<Reference>>;
  readonly avoidCollisions?: boolean;
  readonly scalarsOnly?: boolean;
}

export function createIncrementalQueriesV2(
  cfg: IncrementalQueriesConfig
): ReadonlyArray<Query> {
  const avoidCollisions = cfg.avoidCollisions ?? true;
  const scalarsOnly = cfg.scalarsOnly ?? false;
  const result: Query[] = [];
  const resolvedPrimaryKeys = cfg.primaryKeys
    ? new PrimaryKeyResolver(
        cfg.graphSchema,
        cfg.primaryKeys,
        cfg.references || {}
      ).resolvePrimaryKeys()
    : {};
  for (const name of Object.keys(cfg.graphSchema.getTypeMap())) {
    const type = cfg.graphSchema.getType(name);
    let typeReferences = {};
    if (cfg.references && type) {
      typeReferences = cfg.references[type.name] || {};
    }

    if (isV2ModelType(type)) {
      result.push(
        buildIncrementalQueryV2({
          type,
          resolvedPrimaryKeys,
          references: typeReferences,
          avoidCollisions,
          scalarsOnly,
        })
      );
    }
  }

  return result;
}

/**
 * Converts a V2 query into incremental:
 * Adds "from" and "to" query variables.
 * Adds a filter "from" <= refreshedAt < "to" to the top level model.
 * Makes sure refreshedAt is selected.
 *
 * Example:
 *  vcs_PullRequest {
 *    title
 *  }
 *
 * becomes:
 *  query incrementalQuery($from: timestamptz!, $to: timestamptz!) {
 *    vcs_PullRequest(where: {refreshedAt: {_gte: $from, _lt: $to}}) {
 *      title
 *      refreshedAt
 *    }
 *  }
 */
export function toIncrementalV2(query: string): string {
  let hasRefreshedAt = false,
    firstNodesSeen = false;
  let fieldDepth = 0;

  const ast = gql.visit(gql.parse(query), {
    Document(node) {
      if (node.definitions.length !== 1) {
        throw invalidQuery(
          'document should contain a single query operation definition'
        );
      }
    },
    OperationDefinition(node) {
      if (node.operation !== 'query') {
        throw invalidQuery('only query operations are supported');
      }

      // Add refreshedAt filter variables to query operation
      return withVariableDefinitions(node, [
        {
          kind: Kind.VARIABLE_DEFINITION,
          variable: {
            kind: Kind.VARIABLE,
            name: {kind: Kind.NAME, value: 'from'},
          },
          type: {
            kind: Kind.NAMED_TYPE,
            name: {kind: Kind.NAME, value: 'timestamptz!'},
          },
        },
        {
          kind: Kind.VARIABLE_DEFINITION,
          variable: {
            kind: Kind.VARIABLE,
            name: {kind: Kind.NAME, value: 'to'},
          },
          type: {
            kind: Kind.NAMED_TYPE,
            name: {kind: Kind.NAME, value: 'timestamptz!'},
          },
        },
      ]);
    },
    Field: {
      enter(node) {
        const name = node.alias?.value ?? node.name.value;

        if (!firstNodesSeen) {
          firstNodesSeen = true;
          fieldDepth++;
          return undefined;
        }
        if (!hasRefreshedAt) {
          if (name === 'refreshedAt') {
            hasRefreshedAt = true;
            fieldDepth++;
            return undefined;
          }
          return false;
        }
        return false;
      },
      leave(node) {
        fieldDepth--;

        // We're at the top level model
        // Add the filter here and refreshedAt to selections if needed
        if (fieldDepth === 0) {
          const refreshedFilter = buildRefreshedFilter(
            'where',
            'refreshedAt',
            '_gte',
            '_lt'
          );

          const selections = node.selectionSet?.selections || [];
          const newSelection = {
            kind: 'Field',
            name: {kind: 'Name', value: 'refreshedAt'},
          };
          return {
            ...node,
            arguments: [...(node.arguments || []), refreshedFilter],
            selectionSet: {
              kind: Kind.SELECTION_SET,
              selections: hasRefreshedAt
                ? selections
                : [...selections, newSelection],
            },
          };
        }
        return undefined;
      },
    },
  });
  return gql.print(ast);
}

/**
 * Returns the path to the queried top-level model in a V2 query
 *
 * Example, for query:
 *  vcs_PullRequest {
 *    title
 *  }
 *
 * returns:
 * {
 *  modelName: 'vcs_PullRequest',
 *  path: ['vcs_PullRequest'],
 * }
 */
export function pathToModelV2(
  query: string,
  schema: gql.GraphQLSchema
): PathToModel {
  const typeInfo = new gql.TypeInfo(schema);
  let modelName: string | undefined;
  const fieldPath: string[] = [];

  gql.visit(
    gql.parse(query),
    gql.visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node) {
          const name = node.alias?.value ?? node.name.value;
          const type = typeInfo.getParentType();

          if (isV2ModelType(type)) {
            modelName = type.name;
            return false;
          }

          fieldPath.push(name);
          return undefined;
        },
      },
    })
  );

  ok(modelName !== undefined, 'Could not find queried top-level model');

  return {
    path: fieldPath,
    modelName,
  };
}

function withVariableDefinitions(
  node: gql.OperationDefinitionNode,
  variableDefinitions: ReadonlyArray<gql.VariableDefinitionNode>
): gql.OperationDefinitionNode {
  return {
    kind: Kind.OPERATION_DEFINITION,
    name: {kind: Kind.NAME, value: 'incrementalQuery'},
    operation: gql.OperationTypeNode.QUERY,
    variableDefinitions: [
      ...variableDefinitions,
      ...(node.variableDefinitions || []),
    ],
    selectionSet: node.selectionSet,
  };
}

function buildRefreshedFilter(
  argumentName: string,
  compareFieldName: string,
  fromComparison: string,
  toComparison: string
): any {
  return {
    kind: 'Argument',
    name: {
      kind: 'Name',
      value: argumentName,
    },
    value: {
      kind: 'ObjectValue',
      fields: [
        {
          kind: 'ObjectField',
          name: {
            kind: 'Name',
            value: compareFieldName,
          },
          value: {
            kind: 'ObjectValue',
            fields: [
              {
                kind: 'ObjectField',
                name: {
                  kind: 'Name',
                  value: fromComparison,
                },
                value: {
                  kind: 'Variable',
                  name: {
                    kind: 'Name',
                    value: 'from',
                  },
                },
              },
              {
                kind: 'ObjectField',
                name: {
                  kind: 'Name',
                  value: toComparison,
                },
                value: {
                  kind: 'Variable',
                  name: {
                    kind: 'Name',
                    value: 'to',
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };
}

class PrimaryKeyResolver {
  constructor(
    readonly graphQLSchema: gql.GraphQLSchema,
    readonly primaryKeys: Dictionary<ReadonlyArray<string>>,
    readonly references: Dictionary<Dictionary<Reference>>
  ) {}

  /**
   * Fully resolves the primary keys of models in the schema.
   *
   * E.g., if the primary keys of 'cicd_Organization' are 'source'
   * and 'uid' (both scalars) and the primary keys of 'cicd_Pipeline'
   * are 'organization' (foreign key to cicd_Organization) and 'uid' (scalar),
   * the fully resolved primary key of 'cicd_Pipeline' is
   * { organization { source uid } uid }
   */
  public resolvePrimaryKeys(): Dictionary<string> {
    const result: Dictionary<string> = {};

    for (const name of Object.keys(this.graphQLSchema.getTypeMap())) {
      const type = this.graphQLSchema.getType(name);
      if (isV2ModelType(type)) {
        result[name] = this.resolvePrimaryKey(type);
      }
    }

    return result;
  }

  @Memoize((type: gql.GraphQLObjectType) => type.name)
  private resolvePrimaryKey(type: gql.GraphQLObjectType): string {
    const resolved = [];
    const typeReferences = this.references[type.name] || {};

    for (const fldName of this.primaryKeys[type.name] || []) {
      const reference = typeReferences[fldName];
      let field;
      if (reference) {
        field = type.getFields()[reference.field];
        ok(
          !_.isNil(field),
          `expected ${reference.field} to be a reference field of` +
            ` ${type.name} (foreign key to ${reference.model})`
        );
      } else {
        field = type.getFields()[fldName];
        ok(
          !_.isNil(field),
          `expected ${fldName} to be a field of ${type.name}`
        );
      }

      if (gql.isScalarType(unwrapType(field.type))) {
        resolved.push(field.name);
      } else if (isV2ModelType(field.type)) {
        resolved.push(
          `${field.name} { ${this.resolvePrimaryKey(field.type)} }`
        );
      }
    }

    return resolved.join(' ');
  }
}
