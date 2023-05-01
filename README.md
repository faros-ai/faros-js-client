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
    // The QueryBuilder manages origin for you
    const qb = new QueryBuilder(ORIGIN);

    const application: MutationParams = {
      model: 'compute_Application',
      key: {
        name: '<application_name>',
        platform: '<application_platform>',
      },
    };
    const deployment: MutationParams = {
      model: 'cicd_Deployment',
      key: {
        uid: '<deployment_uid',
        source: '<deployment_source>',
      },
      body: {
        // Fields that reference another model need to be refs
        application: qb.ref(application),
        status: {
          category: 'Success',
          detail: '<status_detail>',
        },
      },
    };

    const mutations = [
      qb.upsert(application),
      qb.upsert(deployment)
    ];

    // Send your mutations to Faros!
    await client.sendMutations(mutations);
```

Please read the [Faros documentation][farosdocs] to learn more.

[farosdocs]: https://docs.faros.ai
