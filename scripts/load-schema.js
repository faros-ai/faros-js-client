#!/usr/bin/env node

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {Command} = require('commander');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {HasuraSchemaLoader} = require('../lib');

const program = new Command('perf')
  .description('Run schema loader against Hasura instance')
  .requiredOption('--url <url>', 'Hasura URL')
  .requiredOption('--admin-secret <key>', 'admin secret')
  .action(async (opts) => {
    const loader = new HasuraSchemaLoader(opts.url, opts.adminSecret, true);
    const res = await loader.loadSchema();
    console.log(JSON.stringify(res, null, 2));
  });

program.parse(process.argv);
