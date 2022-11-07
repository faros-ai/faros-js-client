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
    url: 'https://dev.api.faros.ai',
    apiKey: 'xyz',
});

const exists = await faros.graphExists('graph1');

const query = `{
      tms {
        tasks {
          nodes {
            uid
          }
        }
      }
}`;
const data = await client.gql('graph1', query);
```

Please read the [Faros documentation][farosdocs] to learn more.

[farosdocs]: https://www.faros.ai/docs
