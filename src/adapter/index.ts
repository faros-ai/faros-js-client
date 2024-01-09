import * as gql from 'graphql';
import {Maybe} from 'graphql/jsutils/Maybe';
import _ from 'lodash';
import {DateTime} from 'luxon';
import {singular} from 'pluralize';
import {Writable} from 'ts-essentials';
import VError from 'verror';

import {FarosClient} from '../client';
import {
  isEmbeddedObjectListType,
  isEmbeddedObjectType,
  isModelQuery,
  isObjectListType,
  METADATA,
  NODES,
  paginatedQueryV2,
  REFRESHED_AT
} from '../graphql/graphql';
import {
  asLeafValueType,
  FieldPaths,
  isLeafType,
  isLeafValue,
  isNestedValue,
  isPrimitiveListType,
  isTypedArray,
  LeafValueType,
} from './types';

export {FieldPaths} from './types';

/**
 * Converts a V1 query namespace, specified as a model namespace and model name,
 * into a V2 query namespace.
 *
 * For example, queryNamespace('vcs', 'commits') returns 'vcs_Commit'.
 */
function queryNamespace(modelNamespace: string, model: string): string {
  let modelName;
  if (modelNamespace === 'faros' && model.endsWith('Options')) {
    // Don't singularize options models
    modelName = model;
  } else {
    modelName = singular(model);
  }
  return `${modelNamespace}_${_.upperFirst(modelName)}`;
}

/**
 * Returns the V2 field for an embedded V1 field.
 *
 * For example, embeddedName('env', 'category') returns 'envCategory'.
 */
function embeddedName(parentName: string, fieldName: string): string {
  return `${parentName}${_.upperFirst(fieldName)}`;
}

/** Should this V1 field be omitted from a V2 query? */
function omitField(name: string, type: gql.GraphQLOutputType): boolean {
  return name === METADATA || name === NODES || isEmbeddedObjectType(type);
}

/** Extracts nested fields with optional field rename */
function nestedFields(
  field: gql.FieldNode,
  rename?: (name: string) => string
): gql.FieldNode[] {
  const nestedFields: gql.FieldNode[] = [];
  const selections = field.selectionSet?.selections ?? [];
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      const name = selection.name.value;
      nestedFields.push({
        ...selection,
        name: {
          kind: gql.Kind.NAME,
          value: rename ? rename(name) : name
        }
      });
    }
  }
  return nestedFields;
}

/**
 * Returns a mapping from V2 to V1 field paths. If a field is an object list,
 * then its path will point to a nested structure that contains paths that
 * are relative to it.
 *
 * Note: In V2, fields inside embedded object lists are stored identically to
 * those in V1. The "mirrorPaths" boolean argument is true whenever traversal is
 * happening inside an emdedded object list. This causes the V1 and V2 paths to
 * be set to the same values, i.e., they'll be "mirrored".
 */
export function getFieldPaths(
  ast: gql.ASTNode,
  typeInfo: gql.TypeInfo,
  mirrorPaths = false
): FieldPaths {
  const fieldStack: string[] = [];
  const newFieldStack: string[] = [];
  function pushField(name: string, type: gql.GraphQLOutputType): void {
    fieldStack.push(name);
    if (mirrorPaths || !omitField(name, type)) {
      newFieldStack.push(name);
    }
  }
  function popField(name: string): void {
    fieldStack.pop();
    if (mirrorPaths || _.last(newFieldStack) === name) {
      newFieldStack.pop();
    }
  }

  const fieldPaths: Writable<FieldPaths> = {};
  gql.visit(ast, gql.visitWithTypeInfo(typeInfo, {
    Field: {
      enter(node) {
        let type = typeInfo.getType();
        const parentType = typeInfo.getParentType();
        if (gql.isNonNullType(type)) {
          type = type.ofType;
        }
        if (!type) {
          throw new VError(
            'unable to determine type of field: %s',
            fieldStack.join('.')
          );
        }

        const fieldName = node.name.value;
        pushField(fieldName, type);
        if (isModelQuery(parentType, type)) {
          // Convert the V1 query namespace to a V2 query namespace
          // For example: vcs { commits { ...} } => vcs_Commit { ... }
          newFieldStack.shift();
          newFieldStack.shift();
          const [namespace, name] = fieldStack;
          newFieldStack.unshift(queryNamespace(namespace, name));
        } else if (isObjectListType(type)) {
          // Recursive call to next object list
          const nextNode = node.selectionSet;
          if (nextNode) {
            const newFieldPath = newFieldStack.join('.');
            const fieldPath = fieldStack.join('.');
            typeInfo.enter(nextNode);
            fieldPaths[newFieldPath] = {
              path: fieldPath,
              nestedPaths: getFieldPaths(
                nextNode,
                typeInfo,
                mirrorPaths || isEmbeddedObjectType(type.ofType)
              )
            };
            typeInfo.leave(nextNode);
            popField(fieldName);
            return false;
          }
        } else if (isLeafType(type)) {
          const fieldPath = fieldStack.join('.');
          let newFieldPath = newFieldStack.join('.');
          // Timestamps in v1 are always stringified epoch millis, except when
          // they're inside embedded object lists. In that case, they're stored
          // as epoch millis.
          const stringifyTimestamps = !mirrorPaths;
          let fieldType = asLeafValueType(type, stringifyTimestamps);
          if (mirrorPaths) {
            fieldPaths[fieldPath] = {path: fieldPath, type: fieldType};
            return undefined;
          } else if (isEmbeddedObjectType(parentType)) {
            const parentName = fieldStack[fieldStack.length - 2];
            if (parentName === METADATA) {
              if (fieldName === REFRESHED_AT) {
                // Hack: While V1 serializes "refreshedAt" the same as other
                // timestamps (epoch millis string), it types it as a string.
                // In V2, it's stored and typed like every other timestamp.
                // We force conversion from ISO 8601 string => epoch millis
                // string by overriding the type from string to timestamp.
                fieldType = 'epoch_millis_string';
              }
            } else {
              // Prefix the last field name with the embedded field name
              newFieldPath = [
                ...newFieldStack.slice(0, -1),
                embeddedName(parentName, fieldName)
              ].join('.');
            }
          }
          fieldPaths[newFieldPath] = {path: fieldPath, type: fieldType};
        }
        return undefined;
      },
      leave(node) {
        popField(node.name.value);
      }
    }
  }));
  return fieldPaths;
}

/**
 * Converts a V1 query into a V2 query using the following rules:
 *
 * 1. Replaces the first two field selections, i.e., the model namespace and
 *    name, are replaced by a single, combined selection. Example:
 *
 *    vcs { commits { sha createdAt } } => vcs_Commit { sha createdAt }
 *
 * 2. Flattens the selection set of each "nodes" and "metadata" field into the
 *    selection set of its parent. Examples:
 *
 *    commits { nodes { sha createdAt } } => commits { sha createdAt }
 *    commit { metadata { refreshedAt } } => commit { refreshedAt }
 *
 * 3. Flattens the selection set of each embedded field into the selection set
 *    of its parent, prefixing names of nested fields with the parent name.
 *    Example:
 *
 *    deployment { env { category } } => deployment { envCategory }
 *
 * 4. Removes nested fields from embedded object lists since these are stored
 *    as JSONB arrays in V2 and cannot be extracted. Example:
 *
 *    task { additionalFields { name value } } => task { additionalFields }
 *
 * 5. Renames the "first" field argument to "limit". Example:
 *
 *    deployments(first: 1) { uid } => deployments(limit: 1) { uid }
 */
export function asV2AST(ast: gql.ASTNode, typeInfo: gql.TypeInfo): gql.ASTNode {
  return gql.visit(ast, gql.visitWithTypeInfo(typeInfo, {
    Field: {
      // Handles rule (1)
      leave(node, key, parent, path, ancestors) {
        const grandparent = ancestors[ancestors.length - 2];
        if (isTypedArray<gql.ASTNode>(grandparent)) {
          return undefined;
        } else if (grandparent.kind !== 'OperationDefinition') {
          return undefined;
        } else if (grandparent.operation !== 'query') {
          throw new Error('only queries can be converted');
        }

        const modelField = node.selectionSet?.selections?.[0];
        if (!modelField || modelField.kind !== 'Field') {
          throw new Error('query does not select a model');
        }
        const modelNamespace = node.name.value;
        const model = modelField.name.value;
        return {
          ...modelField,
          name: {
            kind: gql.Kind.NAME,
            value: queryNamespace(modelNamespace, model)
          },
        };
      }
    },
    // Handles rules (2), (3) and (4)
    SelectionSet: {
      leave(node) {
        const newSelections: gql.SelectionNode[] = [];
        for (const selection of node.selections) {
          typeInfo.enter(selection);
          const selectionType = typeInfo.getType();
          if (selection.kind === 'Field') {
            if (
              selection.name.value === NODES ||
              selection.name.value === METADATA
            ) {
              // Rule (2): flatten nodes and metadata fields
              newSelections.push(...nestedFields(selection));
            } else if (isEmbeddedObjectType(selectionType)) {
              // Rule (3): flatten embedded fields and rename them
              const prefix = selection.name.value;
              newSelections.push(...nestedFields(
                selection,
                (name) => embeddedName(prefix, name)
              ));
            } else if (isEmbeddedObjectListType(selectionType)) {
              // Rule (4): omit fields from embedded object lists
              newSelections.push(_.omit(selection, 'selectionSet'));
            } else {
              // Otherwise, leave the nested fields alone
              newSelections.push(selection);
            }
          }
          typeInfo.leave(selection);
        }
        return {kind: gql.Kind.SELECTION_SET, selections: newSelections};
      }
    },
    // Handles rule (5)
    Argument(node) {
      if (node.name.value === 'first') {
        return {...node, name: {kind: gql.Kind.NAME, value: 'limit'}};
      }
      return undefined;
    }
  }));
}

/** Shim that retrieves data from a V2 graph using a V1 query */
export class QueryAdapter {
  constructor(
    private readonly faros: FarosClient,
    private readonly v1Schema: gql.GraphQLSchema,
    private readonly v2Schema: Maybe<gql.GraphQLSchema> = undefined
  ) {
    if (faros.graphVersion !== 'v2') {
      throw new VError(
        'query adapter only works with v2 clients. found version: %s',
        faros.graphVersion
      );
    }
  }

  /** Converts a V2 field value into a V1 field value */
  private v1Value(v2Value: any, type: LeafValueType): any {
    if (isPrimitiveListType(type)) {
      if (Array.isArray(v2Value)) {
        // Recursively convert entries
        const v1List: any[] = [];
        for (const v2EntryValue of v2Value) {
          v1List.push(this.v1Value(v2EntryValue, type.entryType));
        }
        return v1List;
      }
      return v2Value;
    } else if (_.isNil(v2Value)) {
      return v2Value;
    }

    if (type === 'float' || type === 'double') {
      if (_.isString(v2Value)) {
        const double = parseFloat(v2Value);
        if (!isNaN(double)) {
          return double;
        }
      } else if (_.isNumber(v2Value)) {
        return v2Value;
      }
      throw new VError('invalid double: %s', v2Value);
    } else if (type === 'long') {
      // Long may be a string or number in V2
      if (_.isString(v2Value)) {
        if (/^-?\d+$/.test(v2Value)) {
          return v2Value;
        }
      } else if (_.isNumber(v2Value)) {
        return `${v2Value}`;
      }
      throw new VError('invalid long: %s', v2Value);
    } else if (type === 'epoch_millis' || type === 'epoch_millis_string') {
      const stringify = type === 'epoch_millis_string';
      if (_.isString(v2Value)) {
        const millis = DateTime.fromISO(v2Value).toMillis();
        if (!isNaN(millis)) {
          return stringify ? `${millis}` : millis;
        }
      } else if (_.isNumber(v2Value)) {
        return stringify ? `${v2Value}` : v2Value;
      }
      throw new VError('invalid timestamp: %s', v2Value);
    }
    return v2Value;
  }

  /** Converts a V2 node into a V1 node */
  private v1Node(v2Node: any, fieldPaths: FieldPaths): any {
    const v1Node: any = {};
    for (const [v2Path, v1Path] of Object.entries(fieldPaths)) {
      if (isLeafValue(v1Path)) {
        try {
          const v1Value = this.v1Value(_.get(v2Node, v2Path), v1Path.type);
          _.set(v1Node, v1Path.path, v1Value);
        } catch (err: any) {
          throw new VError(
            err,
            'failed to convert value in v2 field \'%s\' into value in v1 ' +
              'field \'%s\' of type \'%s\'',
            v2Path,
            v1Path.path,
            isPrimitiveListType(v1Path.type)
              ? `[${v1Path.type.entryType}]`
              : v1Path.type
          );
        }
      } else {
        const nestedV1Nodes: any[] = [];
        const nestedV2Nodes = _.get(v2Node, v2Path);
        const nestedPaths = v1Path.nestedPaths;
        if (Array.isArray(nestedV2Nodes)) {
          for (const nestedV2Node of nestedV2Nodes) {
            const nestedV1Node = this.v1Node(nestedV2Node, nestedPaths);
            if (nestedV1Node) {
              nestedV1Nodes.push(nestedV1Node);
            }
          }
        }
        _.set(v1Node, v1Path.path, nestedV1Nodes);
      }
    }
    return v1Node;
  }

  /** Returns paths relative to the initial nodes path */
  private nodePathsV1(
    v1AST: gql.ASTNode,
    v1TypeInfo: gql.TypeInfo
    ): FieldPaths {
    const fieldPaths = getFieldPaths(v1AST, v1TypeInfo);
    const [pathValue] = Object.values(fieldPaths);
    if (isNestedValue(pathValue)) {
      return pathValue.nestedPaths;
    }
    throw new VError('invalid path value: %s', pathValue);
  }

  private nodePathsV2(
    v2AST: gql.ASTNode,
    v2TypeInfo: gql.TypeInfo
  ): FieldPaths {
    const fieldPaths = getFieldPaths(v2AST, v2TypeInfo);
    console.log(fieldPaths);
    const [pathValue] = Object.values(fieldPaths);
    if (isNestedValue(pathValue)) {
      return pathValue.nestedPaths;
    }
    console.log(pathValue);
    throw new VError('invalid path value: %s', pathValue);
  }

  nodes(
    graph: string,
    query: string,
    pageSize = 100,
    args: Map<string, any> = new Map<string, any>(),
    postProcessV2Query: (v2Query: string) => string = _.identity
  ): AsyncIterable<any> {
        // Returns an object with a default async iterator
    // We try gql validation against v2 schema if v1 schema fails
    const queryAST = gql.parse(query);
    const v1ValidationErrors = gql.validate(this.v1Schema, queryAST);
    let v2Nodes: AsyncIterable<any>;
    if (this.v2Schema && v1ValidationErrors.length > 0) {
      const v2ValidationErrors = gql.validate(this.v2Schema, queryAST);
      if (v2ValidationErrors.length > 0) {
        throw new VError(
          'invalid query: %s\nValidation errors: %s',
          query,
          v1ValidationErrors.map((err) => err.message).join(', ') +
            v2ValidationErrors.map((err) => err.message).join(', ')
        );
      }
      v2Nodes = this.faros.nodeIterable(
        graph,
        query,
        pageSize,
        paginatedQueryV2,
        args
      );
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<any> {
          for await (const v2Node of v2Nodes) {
            yield v2Node;
          }
        },
      };
    }

    const v1TypeInfo = new gql.TypeInfo(this.v1Schema);
    const v2Query = postProcessV2Query(
      gql.print(asV2AST(queryAST, v1TypeInfo))
    );
    const nodePaths = this.nodePathsV1(queryAST, v1TypeInfo);
    v2Nodes = this.faros.nodeIterable(
      graph,
      v2Query,
      pageSize,
      paginatedQueryV2,
      args
    );
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<any> {
        for await (const v2Node of v2Nodes) {
          yield self.v1Node(v2Node, nodePaths);
        }
      },
    };
  }
}
