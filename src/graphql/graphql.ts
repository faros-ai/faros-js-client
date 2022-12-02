import {ok} from 'assert';
import * as gql from 'graphql';
import {Kind} from 'graphql';
import {jsonToGraphQLQuery, VariableType} from 'json-to-graphql-query';
import _ from 'lodash';
import {plural} from 'pluralize';
import {Dictionary} from 'ts-essentials';
import {Memoize} from 'typescript-memoize';
import {VError} from 'verror';

import {FarosClient} from '../client';
import {PathToModel, Query, Reference} from './types';

export type AnyRecord = Record<string, any>;
type AsyncOrSyncIterable<T> = AsyncIterable<T> | Iterable<T>;
export type RecordIterable = AsyncOrSyncIterable<AnyRecord>;

export interface PaginatedQuery {
  readonly query: string;
  readonly edgesPath: ReadonlyArray<string>;
  readonly pageInfoPath: ReadonlyArray<string>;
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

const NODES = 'nodes';
const EDGES = 'edges';

const DEFAULT_DIRECTIVE = 'default';
const MAX_NODE_DEPTH = 10;

const ID_FLD = 'id';

// Argument types that pass through pagination
const ALLOWED_ARG_TYPES = new Set(['where', 'filter']);

function invalidQuery(message: string): Error {
  return new Error(`invalid query: ${message}`);
}

/** Returns paths to all node collections in a query */
export function queryNodesPaths(query: string): ReadonlyArray<string[]> {
  const fieldPath: string[] = [];
  const nodesPaths: string[][] = [];
  gql.visit(gql.parse(query), {
    Document(node) {
      const definition = node.definitions[0];
      if (
        node.definitions.length !== 1 ||
        definition.kind !== 'OperationDefinition' ||
        definition.operation !== 'query'
      ) {
        throw invalidQuery(
          'document should contain a single query operation definition'
        );
      }
    },
    Field: {
      enter(node) {
        const name = node.alias?.value ?? node.name.value;
        fieldPath.push(name);
        if (name === NODES) {
          nodesPaths.push([...fieldPath]);
        }
      },
      leave() {
        fieldPath.pop();
      },
    },
  });
  return nodesPaths;
}

export function paginatedQuery(query: string): PaginatedQuery {
  const fieldPath: string[] = [];
  const edgesPath: string[] = [];
  const pageInfoPath: string[] = [];
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

      // Verify that all fields up until the first nodes field
      // contain a single selection
      const selections = [...node.selectionSet.selections];
      while (selections.length) {
        if (selections.length > 1) {
          throw invalidQuery(
            'query operation can only contain a single selection'
          );
        }
        const selection = selections.pop();
        if (selection?.kind === 'Field') {
          if (selection.name.value === NODES) {
            break;
          }
          selections.push(...(selection.selectionSet?.selections || []));
        }
      }

      // Add pagination variables to query operation
      return createOperationDefinition(node);
    },
    Field: {
      enter(node) {
        fieldPath.push(node.name.value);
        const isParentOfNodes = node.selectionSet?.selections.some(
          (s) => s.kind === 'Field' && s.name.value === NODES
        );

        if (edgesPath.length) {
          // Skip rest of nodes once edges path has been set
          return false;
        } else if (isParentOfNodes) {
          pageInfoPath.push(...fieldPath, 'pageInfo');
          // copy existing filter args
          const existing = (node.arguments ?? []).filter((n) =>
            ALLOWED_ARG_TYPES.has(n.name.value)
          );
          return {
            kind: 'Field',
            name: node.name,
            // Add pagination arguments
            arguments: [
              ...existing,
              {
                kind: 'Argument',
                name: {kind: 'Name', value: 'first'},
                value: {
                  kind: 'Variable',
                  name: {kind: 'Name', value: 'pageSize'},
                },
              },
              {
                kind: 'Argument',
                name: {kind: 'Name', value: 'after'},
                value: {
                  kind: 'Variable',
                  name: {kind: 'Name', value: 'cursor'},
                },
              },
            ],
            // Add pageInfo alongside the existing selection set
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                ...(node.selectionSet?.selections || []),
                {
                  kind: 'Field',
                  name: {kind: 'Name', value: 'pageInfo'},
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      {
                        kind: 'Field',
                        name: {kind: 'Name', value: 'hasNextPage'},
                      },
                    ],
                  },
                },
              ],
            },
          };
        } else if (node.name.value === NODES) {
          edgesPath.push(...fieldPath.slice(0, -1), EDGES);
          // Replace the first nodes field with edges field
          return {
            kind: 'Field',
            name: {kind: 'Name', value: EDGES},
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: {kind: 'Name', value: 'cursor'},
                },
                {
                  kind: 'Field',
                  name: {kind: 'Name', value: 'node'},
                  selectionSet: node.selectionSet,
                },
              ],
            },
          };
        }
        return undefined;
      },
      leave() {
        fieldPath.pop();
      },
    },
  });

  return {
    query: gql.print(ast),
    edgesPath,
    pageInfoPath,
  };
}

function isLeafType(type: any): boolean {
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
    return gql.isLeafType(ofType) || gql.isObjectType(ofType);
  }
  return gql.isLeafType(type);
}

function createOperationDefinition(
  node: gql.OperationDefinitionNode,
  cursorType = 'Cursor'
): gql.OperationDefinitionNode {
  return {
    kind: Kind.OPERATION_DEFINITION,
    name: {kind: Kind.NAME, value: 'paginatedQuery'},
    operation: gql.OperationTypeNode.QUERY,
    variableDefinitions: [
      {
        kind: Kind.VARIABLE_DEFINITION,
        variable: {
          kind: Kind.VARIABLE,
          name: {kind: Kind.NAME, value: 'pageSize'},
        },
        type: {
          kind: Kind.NAMED_TYPE,
          name: {kind: Kind.NAME, value: 'Int'},
        },
      },
      {
        kind: Kind.VARIABLE_DEFINITION,
        variable: {
          kind: Kind.VARIABLE,
          name: {kind: Kind.NAME, value: 'cursor'},
        },
        type: {
          kind: Kind.NAMED_TYPE,
          name: {kind: Kind.NAME, value: cursorType},
        },
      },
      ...(node.variableDefinitions || []),
    ],
    selectionSet: node.selectionSet,
  };
}

/**
 * Paginates v2 graphql queries.
 */
export function paginatedQueryV2(query: string): PaginatedQuery {
  const edgesPath: string[] = [];
  const pageInfoPath: string[] = [];
  let firstNode = true;
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
      return createOperationDefinition(node, 'String');
    },
    Field: {
      enter(node) {
        if (edgesPath.length) {
          // Skip rest of nodes once edges path has been set
          return false;
        } else if (firstNode) {
          firstNode = false;
          const newNodeName = `${node.name.value}_connection`;
          pageInfoPath.push(newNodeName, 'pageInfo');
          edgesPath.push(newNodeName, EDGES);
          // copy existing where args
          const existing = (node.arguments ?? []).filter((n) =>
            ALLOWED_ARG_TYPES.has(n.name.value)
          );
          return {
            kind: 'Field',
            name: {kind: 'Name', value: newNodeName},
            // Add pagination arguments
            arguments: [
              ...existing,
              {
                kind: 'Argument',
                name: {kind: 'Name', value: 'first'},
                value: {
                  kind: 'Variable',
                  name: {kind: 'Name', value: 'pageSize'},
                },
              },
              {
                kind: 'Argument',
                name: {kind: 'Name', value: 'after'},
                value: {
                  kind: 'Variable',
                  name: {kind: 'Name', value: 'cursor'},
                },
              },
            ],
            // Add pageInfo alongside the existing selection set
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: {kind: 'Name', value: EDGES},
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      {
                        kind: 'Field',
                        name: {kind: 'Name', value: 'cursor'},
                      },
                      {
                        kind: 'Field',
                        name: {kind: 'Name', value: 'node'},
                        selectionSet: node.selectionSet,
                      },
                    ],
                  },
                },
                {
                  kind: 'Field',
                  name: {kind: 'Name', value: 'pageInfo'},
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      {
                        kind: 'Field',
                        name: {kind: 'Name', value: 'hasNextPage'},
                      },
                    ],
                  },
                },
              ],
            },
          };
        }
        return undefined;
      },
    },
  });

  return {
    query: gql.print(ast),
    edgesPath,
    pageInfoPath,
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
          if (!rootPath.length) {
            rootPath.push(...fieldPath);
          }
          const type = typeInfo.getType();
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
    params.set(node.variable.name.value, type);
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

/** Flattens nested nodes returned from a query */
export function flatten(
  query: string,
  schema: gql.GraphQLSchema
): FlattenContext {
  const fieldPath: string[] = [];
  const leafPaths: string[] = [];
  const pathToDefault = new Map<string, any>();
  const pathToType = new Map<string, gql.GraphQLType>();
  const params = new Map<string, gql.GraphQLInputType>();
  const typeInfo = new gql.TypeInfo(schema);
  gql.visit(
    gql.parse(query),
    gql.visitWithTypeInfo(typeInfo, {
      VariableDefinition(node: gql.VariableDefinitionNode): boolean {
        addVariableDefinition(node, schema, params);
        return false;
      },
      Argument(): boolean {
        // Skip arg subtrees
        return false;
      },
      Directive(node) {
        setPathToDefault(node, fieldPath, pathToType, pathToDefault);
      },
      Field: {
        enter(node): boolean | void {
          const name = node.alias?.value ?? node.name.value;
          fieldPath.push(name);
          const type = typeInfo.getType();
          if (name !== NODES && isLeafType(type)) {
            const leafPath = fieldPath.join('.');
            const gqlType = unwrapType(type);
            if (!gqlType) {
              throw new VError(
                'cannot unwrap type \'%s\' of field \'%s\'',
                type,
                leafPath
              );
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

  // Verify the query doesn't exceed the max node depth
  const nodesPaths = queryNodesPaths(query);
  if (!nodesPaths.length) {
    throw new VError('query must contain at least one nodes collection');
  }
  for (const path of nodesPaths) {
    let nodeDepth = 0;
    for (const pathPart of path) {
      if (pathPart === NODES) {
        nodeDepth++;
      }
    }
    if (nodeDepth > MAX_NODE_DEPTH) {
      throw new VError('query exceeds max node depth of %d', MAX_NODE_DEPTH);
    }
  }

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
    fieldTypes.set(name, pathToType.get(path)!);
  }

  return {
    fieldTypes,
    params,
    currentPath: nodesPaths[0].join('.'),
    leafToDefault,
    leafPaths,
    depth: 0,
  };
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
  };
}

export function readerFromQuery(
  graph: string,
  faros: FarosClient,
  query: Query,
  pageSize: number,
  graphSchema: gql.GraphQLSchema,
  incremental = false,
  paginator = paginatedQuery,
  flattener = flatten
): Reader {
  const flattenCtx = flattener(query.gql, graphSchema);
  return {
    execute(args: Map<string, any>): AsyncIterable<AnyRecord> {
      const nodes = faros.nodeIterable(
        graph,
        query.gql,
        pageSize,
        paginator,
        args
      );
      return flattenIterable(flattenCtx, nodes);
    },
    metadata: {
      name: query.name,
      fields: flattenCtx.fieldTypes,
      modelKeys: incremental ? [ID_FLD] : undefined,
      params: flattenCtx.params,
    },
  };
}

export function createNonIncrementalReaders(
  client: FarosClient,
  graph: string,
  pageSize: number,
  graphSchema: gql.GraphQLSchema,
  graphqlVersion: string,
  queries: ReadonlyArray<Query>
): ReadonlyArray<Reader> {
  return queries.map((query) => {
    switch (graphqlVersion) {
      case 'v1':
        return readerFromQuery(graph, client, query, pageSize, graphSchema);
      case 'v2':
        return readerFromQuery(
          graph,
          client,
          query,
          pageSize,
          graphSchema,
          false,
          paginatedQueryV2,
          flattenV2
        );
      default:
        throw new VError('invalid graphql version %s', graphqlVersion);
    }
  });
}

/**
 * Creates an incremental query from a model type.
 * The selections will include:
 *  1. All the scalar fields.
 *  2. Nested fragments for all referenced models, selecting their IDs.
 *  3. A fragment "metadata { refreshedAt }"
 *
 * By default, it aliases referenced models IDs to prevent collisions
 * if flattened.
 * E.g., { id pipeline { id } } => { id pipeline { pipelineId: id } }
 * The avoidCollisions parameter controls this behavior.
 *
 * If resolvedPrimaryKeys is provided, it will use the fully resolved
 * primary key fragment for referenced models instead of the ID field.
 */
export function buildIncrementalQueryV1(
  type: gql.GraphQLObjectType,
  avoidCollisions = true,
  resolvedPrimaryKeys: Dictionary<string> = {}
): Query {
  const name = type.name;
  // add fields and FKs
  const fieldsObj: any = {};
  // add PK
  fieldsObj[ID_FLD] = true;
  for (const fldName of Object.keys(type.getFields())) {
    const field = type.getFields()[fldName];
    if (gql.isScalarType(unwrapType(field.type))) {
      fieldsObj[field.name] = true; // arbitrary value here
    } else if (isV1ModelType(field.type)) {
      // this is foreign key to a top-level model.
      // add nested fragment to select id of referenced model
      const fk = resolvedPrimaryKeys[field.type.name] || ID_FLD;

      if (avoidCollisions) {
        let nestedName = `${field.name}Id`;
        // check for collision between nested name and scalars
        if (_.has(type.getFields(), nestedName)) {
          nestedName = `${field.name}Fk`;
        }
        fieldsObj[field.name] = {
          [`${nestedName}: ${fk}`]: true,
        };
      } else {
        fieldsObj[field.name] = {
          [fk]: true,
        };
      }
    }
  }

  // Add refreshedAt
  fieldsObj.metadata = {
    refreshedAt: true,
  };

  // transform name into a dot-separated path for setting fields and filters
  // e.g. cicd_ReleaseTagAssociation => cicd.releaseTagAssociations
  const segments = name.split('_');
  ok(segments.length > 1, `expected 2 or more elements in ${segments}`);
  // last segment is model name and needs to be lowerFirst and plural
  const names = segments.slice(0, -1);
  names.push(_.lowerFirst(plural(_.last(segments) as string)));
  // prepend query
  names.unshift('query');
  // add fields under nodes
  const fieldPath = names.concat('nodes').join('.');
  const query = _.set({}, fieldPath, fieldsObj);
  // add filter for refreshedAt at level of model name
  const filterPath = names.concat('__args').join('.');
  const refreshedFilter = {
    filter: {
      refreshedAtMillis: {
        greaterThanOrEqualTo: new VariableType('from'),
        lessThan: new VariableType('to'),
      },
    },
  };
  _.set(query, filterPath, refreshedFilter);
  _.set(query, 'query.__variables', {
    from: 'builtin_BigInt!',
    to: 'builtin_BigInt!',
  });
  return {name, gql: jsonToGraphQLQuery(query)};
}

function isV1ModelType(type: any): type is gql.GraphQLObjectType {
  return (
    gql.isObjectType(type) &&
    type.getInterfaces().length > 0 &&
    type.getInterfaces()[0].name === 'Node'
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createIncrementalReadersV1(
  client: FarosClient,
  graph: string,
  pageSize: number,
  graphQLSchema: gql.GraphQLSchema
): ReadonlyArray<Reader> {
  const result: Reader[] = createIncrementalQueriesV1(graphQLSchema).map(
    (query) =>
      readerFromQuery(graph, client, query, pageSize, graphQLSchema, true)
  );

  if (!result.length) {
    throw new VError('failed to load v1 incremental readers');
  }
  return result;
}

export function createIncrementalQueriesV1(
  graphQLSchema: gql.GraphQLSchema,
  primaryKeys?: Dictionary<ReadonlyArray<string>>,
  avoidCollisions = true
): ReadonlyArray<Query> {
  const result: Query[] = [];
  const resolvedPrimaryKeys = primaryKeys
    ? new PrimaryKeyResolver(
        graphQLSchema,
        primaryKeys,
        {},
        isV1ModelType
      ).resolvePrimaryKeys()
    : {};
  for (const name of Object.keys(graphQLSchema.getTypeMap())) {
    const type = graphQLSchema.getType(name);
    if (isV1ModelType(type)) {
      result.push(
        buildIncrementalQueryV1(type, avoidCollisions, resolvedPrimaryKeys)
      );
    }
  }

  return result;
}

function isV2ModelType(type: any): type is gql.GraphQLObjectType {
  return gql.isObjectType(type)
    ? type.name !== 'graph' && // exclude graph table from extract
        (type.description ?? '').startsWith('columns and relationships of')
    : false;
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
export function buildIncrementalQueryV2(
  type: gql.GraphQLObjectType,
  avoidCollisions = true,
  resolvedPrimaryKeys: Dictionary<string> = {}
): Query {
  const name = type.name;
  // add fields and FKs
  const fieldsObj: any = {};
  // add PK
  fieldsObj[ID_FLD] = true;
  for (const fldName of Object.keys(type.getFields())) {
    const field = type.getFields()[fldName];
    if (gql.isScalarType(unwrapType(field.type))) {
      fieldsObj[field.name] = true; // arbitrary value here
    } else if (isV2ModelType(field.type)) {
      // this is foreign key to a top-level model.
      // add nested fragment to select id of referenced model
      const fk = resolvedPrimaryKeys[field.type.name] || ID_FLD;
      if (avoidCollisions) {
        let nestedName = `${field.name}Id`;
        // check for collision between nested name and scalars
        if (_.has(type.getFields(), nestedName)) {
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createIncrementalReadersV2(
  client: FarosClient,
  graph: string,
  pageSize: number,
  graphQLSchema: gql.GraphQLSchema
): ReadonlyArray<Reader> {
  const result: Reader[] = createIncrementalQueriesV2(graphQLSchema).map(
    (query) =>
      readerFromQuery(
        graph,
        client,
        query,
        pageSize,
        graphQLSchema,
        true,
        paginatedQueryV2,
        flattenV2
      )
  );
  if (!result.length) {
    throw new VError('failed to create v2 incremental readers');
  }
  return result;
}

export function createIncrementalQueriesV2(
  graphQLSchema: gql.GraphQLSchema,
  primaryKeys?: Dictionary<ReadonlyArray<string>>,
  references?: Dictionary<Dictionary<Reference>>,
  avoidCollisions = true
): ReadonlyArray<Query> {
  const result: Query[] = [];
  const resolvedPrimaryKeys = primaryKeys
    ? new PrimaryKeyResolver(
        graphQLSchema,
        primaryKeys,
        references || {},
        isV2ModelType
      ).resolvePrimaryKeys()
    : {};
  for (const name of Object.keys(graphQLSchema.getTypeMap())) {
    const type = graphQLSchema.getType(name);
    if (isV2ModelType(type)) {
      result.push(
        buildIncrementalQueryV2(type, avoidCollisions, resolvedPrimaryKeys)
      );
    }
  }

  return result;
}

/**
 * Converts a V1 query into incremental:
 * Adds "from" and "to" query variables.
 * Adds a filter "from" <= refreshedAt < "to" to the top level model.
 * Makes sure metadata { refreshedAt } is selected.
 *
 * Example:
 *  vcs {
 *     pullRequests {
 *       nodes {
 *         title
 *       }
 *     }
 *  }
 *
 * becomes:
 *  query incrementalQuery($from: builtin_BigInt!, $to: builtin_BigInt!) {
 *   vcs {
 *     pullRequests(
 *       filter: {
 *        refreshedAtMillis: {
 *          greaterThanOrEqualTo: $from,
 *          lessThan: $to
 *        }
 *       }
 *     ) {
 *       nodes {
 *         title
 *         metadata {
 *           refreshedAt
 *         }
 *       }
 *     }
 *   }
 *  }
 */
export function toIncrementalV1(query: string): string {
  let hasMetadata = false,
    hasRefreshedAt = false,
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

      // Add refreshedAtMillis filter variables to query operation
      return withVariableDefinitions(node, [
        {
          kind: Kind.VARIABLE_DEFINITION,
          variable: {
            kind: Kind.VARIABLE,
            name: {kind: Kind.NAME, value: 'from'},
          },
          type: {
            kind: Kind.NAMED_TYPE,
            name: {kind: Kind.NAME, value: 'builtin_BigInt!'},
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
            name: {kind: Kind.NAME, value: 'builtin_BigInt!'},
          },
        },
      ]);
    },
    Field: {
      enter(node) {
        const name = node.alias?.value ?? node.name.value;

        if (!firstNodesSeen) {
          if (name === NODES) {
            firstNodesSeen = true;
          }
          fieldDepth++;
          return undefined;
        }
        if (!hasMetadata) {
          if (name === 'metadata') {
            hasMetadata = true;
            fieldDepth++;
            return undefined;
          }
          return false;
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
        const name = node.alias?.value ?? node.name.value;
        fieldDepth--;

        // We're at the top level model
        // Add the filter here
        if (fieldDepth === 1) {
          const refreshedFilter = buildRefreshedFilter(
            'filter',
            'refreshedAtMillis',
            'greaterThanOrEqualTo',
            'lessThan'
          );

          return {
            ...node,
            arguments: [...(node.arguments || []), refreshedFilter],
          };
        }

        if (name === NODES && !hasMetadata) {
          // Adds metadata { refreshedAt }
          const selections = node.selectionSet?.selections || [];
          const newSelection = {
            kind: 'Field',
            name: {kind: 'Name', value: 'metadata'},
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: {kind: 'Name', value: 'refreshedAt'},
                },
              ],
            },
          };

          return {
            ...node,
            selectionSet: {
              kind: Kind.SELECTION_SET,
              selections: [...selections, newSelection],
            },
          };
        }
        if (name === 'metadata' && !hasRefreshedAt) {
          // Adds refreshedAt
          const selections = node.selectionSet?.selections || [];
          const newSelection = {
            kind: 'Field',
            name: {kind: 'Name', value: 'refreshedAt'},
          };

          return {
            ...node,
            selectionSet: {
              kind: Kind.SELECTION_SET,
              selections: [...selections, newSelection],
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
 * Returns the path to the queried top-level model in a V1 query
 *
 * Example, for query:
 *  vcs {
 *     pullRequests {
 *       nodes {
 *         title
 *       }
 *     }
 *  }
 *
 * returns:
 * {
 *  modelName: 'vcs_PullRequest',
 *  path: ['vcs', 'pullRequests', 'nodes'],
 * }
 */
export function pathToModelV1(
  query: string,
  schema: gql.GraphQLSchema
): PathToModel {
  const typeInfo = new gql.TypeInfo(schema);
  let firstNodesSeen = false;
  let modelName: string | undefined;
  const fieldPath: string[] = [];

  gql.visit(
    gql.parse(query),
    gql.visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node) {
          const name = node.alias?.value ?? node.name.value;

          if (firstNodesSeen) {
            const type = typeInfo.getParentType();
            ok(isV1ModelType(type));
            modelName = type.name;
            return false;
          }

          fieldPath.push(name);

          if (name === NODES) {
            firstNodesSeen = true;
          }

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
    readonly references: Dictionary<Dictionary<Reference>>,
    readonly isTopLevelModelTypeChecker = isV1ModelType
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
      if (this.isTopLevelModelTypeChecker(type)) {
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
          field !== undefined,
          `expected ${reference.field} to be a field of ${type.name}`
        );
      } else {
        field = type.getFields()[fldName];
        ok(
          field !== undefined,
          `expected ${fldName} to be a field of ${type.name}`
        );
      }

      if (gql.isScalarType(unwrapType(field.type))) {
        resolved.push(field.name);
      } else if (this.isTopLevelModelTypeChecker(field.type)) {
        resolved.push(
          `${field.name} { ${this.resolvePrimaryKey(field.type)} }`
        );
      }
    }

    return resolved.join(' ');
  }
}
