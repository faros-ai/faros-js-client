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

Please read the [Faros documentation][farosdocs] to learn more.

[farosdocs]: https://docs.faros.ai
