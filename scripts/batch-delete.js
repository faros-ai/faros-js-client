#!/usr/bin/env node

/**
 * Batch-delete records from an arbitrary model in a Faros graph.
 *
 * Queries for matching record IDs, then deletes them in pages
 * using the same conditioned-delete pattern as GraphQLClient.resetData.
 *
 * Usage:
 *   node scripts/batch-delete.js \
 *     --url https://prod.api.faros.ai \
 *     --api-key <key> \
 *     --graph default \
 *     --model vcs_Commit \
 *     --origin my-source \
 *     --before 2024-01-01T00:00:00Z \
 *     [--dry-run] \
 *     [--page-size 100] \
 *     [--session <id>]
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {Command} = require('commander');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {FarosClient} = require('../lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pino = require('pino');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {randomUUID} = require('crypto');

async function execGql(client, graph, query) {
  const res = await client.rawGql(graph, query);
  if (res.errors?.length) {
    const messages = res.errors.map((e) => e.message).join('; ');
    throw new Error(`GraphQL errors: ${messages}`);
  }
  if (!res.data) {
    throw new Error('GraphQL response contained no data');
  }
  return res.data;
}

const program = new Command('batch-delete')
  .description('Batch-delete records from a model by origin and/or refreshedAt')
  .requiredOption('--url <url>', 'Faros API URL')
  .requiredOption('--api-key <key>', 'Faros API key')
  .requiredOption('--graph <graph>', 'Graph name (e.g. default)')
  .requiredOption('--model <model>', 'Model to delete from (e.g. vcs_Commit)')
  .option('--origin <origin>', 'Only delete records with this origin')
  .option(
    '--before <iso-date>',
    'Only delete records with refreshedAt before this ISO timestamp'
  )
  .option('--page-size <n>', 'Batch size for queries and deletes', '100')
  .option('--dry-run', 'Only count matching records; do not delete', false)
  .option(
    '--session <id>',
    'Session id for setCtx (for replica consistency). ' +
      'If omitted, a random UUID is generated.'
  )
  .action(async (opts) => {
    const logger = pino({name: 'batch-delete'});
    const client = new FarosClient(
      {url: opts.url, apiKey: opts.apiKey},
      logger
    );

    const pageSize = parseInt(opts.pageSize, 10);
    if (!Number.isFinite(pageSize) || pageSize < 1) {
      logger.error(
        `Invalid --page-size "${opts.pageSize}". Must be a positive integer.`
      );
      process.exit(1);
    }

    const model = opts.model;
    const graph = opts.graph;
    const session = opts.session || randomUUID();

    // Build the where clause from provided filters
    const conditions = {};
    if (opts.origin) {
      conditions.origin = {_eq: opts.origin};
    }
    if (opts.before) {
      conditions.refreshedAt = {_lt: opts.before};
    }

    if (Object.keys(conditions).length === 0) {
      logger.error(
        'At least one filter (--origin or --before) is required to avoid ' +
          'deleting all records. Aborting.'
      );
      process.exit(1);
    }

    const whereClause = Object.entries(conditions)
      .map(([field, op]) => {
        const [operator, value] = Object.entries(op)[0];
        return `${field}: {${operator}: "${value}"}`;
      })
      .join(', ');

    logger.info(
      {model, graph, conditions, session, dryRun: opts.dryRun},
      'Starting batch delete'
    );

    // Paginate through matching IDs using keyset pagination
    let totalFound = 0;
    let totalDeleted = 0;
    let lastId = null;
    let hasMore = true;

    while (hasMore) {
      // Build keyset condition: id > lastId for pagination
      const paginationFilter = lastId
        ? `id: {_gt: "${lastId}"}`
        : '';
      const allConditions = [whereClause, paginationFilter]
        .filter(Boolean)
        .join(', ');

      const query = `query {
        ${model}(
          where: {${allConditions}}
          order_by: {id: asc}
          limit: ${pageSize}
        ) {
          id
        }
      }`;

      const data = await execGql(client, graph, query);
      const records = data[model] || [];

      if (records.length === 0) {
        hasMore = false;
        break;
      }

      totalFound += records.length;
      lastId = records[records.length - 1].id;

      if (opts.dryRun) {
        logger.info(`Found ${records.length} records (total so far: ${totalFound})`);
        hasMore = records.length === pageSize;
        continue;
      }

      // Delete this batch with the original conditions as guardrails,
      // prefixed with setCtx for session affinity / replica consistency
      const ids = records.map((r) => r.id);
      const idsStr = ids.map((id) => `"${id}"`).join(', ');
      const mutation = `mutation {
        ctx: setCtx(args: {session: "${session}"}) { success }
        delete_${model}(
          where: {
            _and: {
              ${whereClause}
              id: {_in: [${idsStr}]}
            }
          }
        ) {
          affected_rows
        }
      }`;

      const result = await execGql(client, graph, mutation);
      const affected = result[`delete_${model}`].affected_rows;
      totalDeleted += affected;

      logger.info(
        `Deleted ${affected} / ${records.length} records ` +
          `(total deleted: ${totalDeleted}, total found: ${totalFound})`
      );

      hasMore = records.length === pageSize;
    }

    if (opts.dryRun) {
      logger.info(`Dry run complete. ${totalFound} records would be deleted.`);
    } else {
      logger.info(
        `Done. Deleted ${totalDeleted} out of ${totalFound} matching records.`
      );
    }
  });

program.parse(process.argv);
