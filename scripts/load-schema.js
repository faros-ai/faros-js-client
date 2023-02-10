#!/usr/bin/env node

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {outputFile} = require('fs-extra');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {Command} = require('commander');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {HasuraSchemaLoader} = require('../lib');

const program = new Command('perf')
  .description('Run schema loader against Hasura instance')
  .requiredOption('--url <url>', 'Hasura URL')
  .requiredOption('--admin-secret <key>', 'admin secret')
  .requiredOption('--output <file>', 'location to write schema')
  .action(async (opts) => {
    const loader = new HasuraSchemaLoader(opts.url, opts.adminSecret, true);
    const res = await loader.loadSchema();
    const schema = JSON.stringify(res, null, 2);
    console.log(`writing hasura schema to ${opts.output}...`);
    await outputFile(opts.output, schema);
  });

program.parse(process.argv);
