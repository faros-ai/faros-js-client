[![CI](https://github.com/faros-ai/faros-js-client/actions/workflows/ci.yml/badge.svg)](https://github.com/faros-ai/faros-js-client/actions/workflows/ci.yml)

# Faros API client for JavaScript/TypeScript

## Installation
```bash
$ npm i --save faros-js-client
```
## Documentation

Usage example:
```typescript
import {FarosClient} from 'faros-js-client';

const faros = new FarosClient({
    url: 'https://prod.api.faros.ai',
    apiKey: '<your_faros_api_key>',
});

const query = `{
  tms {
    tasks(first: 10) {
      nodes {
        uid
      }
    }
  }
}`;

const data = await client.gql('default', query);
```

## GraphQL Query Builder

The QueryBuilder class is a utility to help construct GraphQL mutations from Faros models.

Example constructing the GraphQL mutation that upserts an application and deployment.

```ts
import {QueryBuilder, FarosClient} from "faros-js-client";

const faros = new FarosClient({
    url: 'https://prod.api.faros.ai',
    apiKey: '<your_faros_api_key>',
});

// The QueryBuilder manages the origin for you
const qb = new QueryBuilder('example-origin');

const compute_Application = {
  name: '<application_name>',
  platform: '<application_platform>'
};
const cicd_Deployment = {
  uid: '<deployment_uid',
  source: '<deployment_source>',
  // Fields that reference another model need to be refs
  application: qb.ref({compute_Application}),
  status: {
    category: 'Success',
    detail: '<status_detail>',
  }
};

const mutations = [
  qb.upsert({compute_Application}),
  qb.upsert({cicd_Deployment})
];

// Send your mutations to Faros!
await faros.sendMutations('default', mutations);
```

Example using conflict override to manage a conflict on unqiue constraint

```ts
import {QueryBuilder, FarosClient} from "faros-js-client";

const faros = new FarosClient({
    url: 'https://prod.api.faros.ai',
    apiKey: '<your_faros_api_key>',
});

const qb = new QueryBuilder('example-origin');

const mutations = [
  qb.upsert(
    {org_ApplicationOwnership},
    {
      // Override the conflict clause with the unique constraint
      constraint: 'org_ApplicationOwnership_application_id_unique',
      update_columns: ['teamId', 'refreshedAt'], // Origin will be added automatically
    }
  )
]

// Send your mutations to Faros!
await faros.sendMutations('default', mutations);
```

## Resetting Data with the GraphQL Client

`GraphQLClient.resetData(originProvider, models, isResetSync, options?)`
deletes records of the given models for an origin that were not refreshed by
the records written through the client. By default (`updateResetLimit` is
`true`), the reset cutoff starts at January 1, 2200 and is lowered to the
earliest `refreshedAt` of the root records written by the client. Records of
the origin refreshed before the cutoff are deleted.

Until the client writes a root record, the cutoff matches every record of the
origin. In that case, `resetData` skips the reset of each model and logs a
warning, unless the full deletion is intended:

- `isResetSync` is `true`, e.g. when a connection is cleared or reset.
- The model is listed in `options.fullResetModels`, e.g. when a source
  explicitly requested to delete all records of the model.

```ts
// Deletes all vcs_TeamMembership records of the origin even if no records
// were written. Other models are only reset after records are written.
await client.resetData(
  {getOrigin: () => 'example-origin'},
  ['vcs_TeamMembership', 'vcs_Repository'],
  false,
  {fullResetModels: ['vcs_TeamMembership']}
);
```

Please read the [Faros documentation][farosdocs] to learn more.

[farosdocs]: https://docs.faros.ai
