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

## Development

```sh
export CHAINGUARD_TOKEN=$(chainctl auth token --audience=libraries.cgr.dev)
npm ci
npm run build
npm run lint
npm test
```

### Dependencies

Packages come from [Chainguard Libraries](https://www.chainguard.dev/libraries/javascript),
not `registry.npmjs.org`. The tracked `.npmrc` already points npm at
`libraries.cgr.dev` and reads the credential from `${CHAINGUARD_TOKEN}`. This only
affects installing this repository's own dependencies; consumers of
`faros-js-client` are unaffected, and releases are still published to
`registry.npmjs.org` through `publishConfig` in `package.json`.

For account setup and access requests, see
[Chainguard Libraries at Faros](https://docs.google.com/document/d/12RlO2rMscDyLnp1tesy2XV9pfqLyijrASnhJUxgt2no/edit).

#### Authenticate

Export a token before any `npm` command. The token is short-lived, so re-run
this when installs start failing on authentication:

```sh
export CHAINGUARD_TOKEN=$(chainctl auth token --audience=libraries.cgr.dev)
```

Keep the `${CHAINGUARD_TOKEN}` placeholder in `.npmrc` — that file is tracked by
git, so a literal token there would be committed.

#### Add a package

```sh
npm install <package>
chainctl libraries update-hashes --replace package-lock.json
npm run check:lockfile
git add package.json package-lock.json
```

`update-hashes` rewrites the lockfile `resolved` URLs and integrity hashes to
match the tarballs Chainguard actually serves. `--replace` is required: without
it the original hash is kept alongside Chainguard's, so the lockfile would still
accept the upstream npm tarball.

`npm run check:lockfile` catches both problems — entries still resolving from
`registry.npmjs.org` and entries with more than one hash. It also fails on any
`resolved` host outside `KNOWN_HOSTS`. CI runs it too. This matters because
`npm ci` fetches the `resolved` URL recorded in `package-lock.json` rather than
the `registry` set in `.npmrc`. A 404 during install usually means the version is
not rebuilt by Chainguard yet, or is still inside the `min-release-age` cooldown
in `.npmrc`.

#### `allow-remote` in `.npmrc`

npm 12 defaults `allow-remote` to `none` and only exempts lockfile tarballs
whose URL sits under the configured `registry`. Chainguard serves rebuilt
packages from `libraries.cgr.dev/javascript/` and everything not yet rebuilt
from `libraries.cgr.dev/javascript-upstream/`, so part of this lockfile falls
outside the registry path and `npm ci` fails with `EALLOWREMOTE`. `.npmrc`
therefore sets `allow-remote=all`.

With that gate off, `npm run check:lockfile` is the only thing keeping the
lockfile from resolving a tarball off an arbitrary host, which is why it fails
rather than warns on unknown hosts. Add a host to `KNOWN_HOSTS` in
`scripts/check-chainguard-lockfile.mjs` only when it is deliberate.

npm 11 and older do not know the `allow-remote` key and print
`Unknown project config "allow-remote"`. The warning is harmless.
