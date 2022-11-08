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

const data = await client.gql('graph1', query);
```

Please read the [Faros documentation][farosdocs] to learn more.

[farosdocs]: https://docs.faros.ai
