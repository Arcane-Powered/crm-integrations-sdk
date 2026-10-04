# @arcanepowered/integrations-sdk

Write a third-party API integration in **one file**: connection fields, authentication, a connection test and typed
operations. A host application (a CRM, a workflow engine, an agent) reads that single definition to render the connection
form, store secrets, test credentials, build its blocks or tools and run calls through an SSRF-guarded HTTP client.

- **Declarative where it helps, plain code where it matters.** Fields and params are [zod 4](https://zod.dev) schemas
  with UI metadata. `run` is an ordinary async function.
- **Safe by default.** Every request goes to `https://` on port 443, to the declared base URL only, after checking that
  every resolved address is public. Redirects are refused unless you opt in, responses are size-limited, and
  credentials are dropped on a cross-host redirect.
- **Isomorphic core.** The main entry has no `node:` import, so definitions can be bundled for the browser or a
  sandboxed runtime. The Node adapter (DNS-pinned `fetch`) lives in `@arcanepowered/integrations-sdk/node`.
- **Testable without network.** `@arcanepowered/integrations-sdk/testing` mocks HTTP and runs operations end to end.

```sh
pnpm add @arcanepowered/integrations-sdk zod
```

`zod` (^4.6) is a peer dependency: the host and the integrations must share one zod instance.

## Write an integration in YAML (recommended)

Most REST integrations are pure configuration. Describe them in a manifest, parse it with any YAML library and pass it
to `fromManifest`:

```yaml
id: bank
label: Bank
base_url: https://api.bank.example/v2

connection:
  login:     { label: Login, private: true }              # encrypted, shown as a normal input
  secretKey: { label: Secret key, secret: true, pattern: '^\S{8,}$', error: Invalid key }

auth:
  header: { name: Authorization, value: '{{login}}:{{secretKey}}' }   # or basic: {username, password} / bearer: '{{token}}'

test: GET /organization

operations:
  transactions:
    label: Transactions
    description: Lists the transactions of an account.
    params:
      iban:   { label: IBAN, required: true }
      status: { label: Status, type: select, options: { completed: Completed, pending: Pending } }
      since:  { label: Settled since, type: date, template: true }
    request:
      path: /transactions
      query: { iban: '{{iban}}', 'status[]': '{{status}}', settled_at_from: '{{since}}' }
    output:
      items: { path: $.transactions, type: list, item: object, label: Transactions }
      total: { path: $.meta.total_count, type: number }
    output_doc: '{ items, total }'
```

```ts
import { parse } from 'yaml';
import { fromManifest } from '@arcanepowered/integrations-sdk';

export const bank = fromManifest(parse(await readFile('bank.yaml', 'utf8')));
```

Reference:

- **connection fields**: `label`, `help`, `placeholder`, `type` (`text` · `url` · `email`), `secret` (masked, encrypted),
  `private` (encrypted, plain input), `required` (default `true`), `trim` (default `true`), `pattern`, `max_length`,
  `error`, `validate` (named validator). Fields that are neither `secret` nor `private` are public config.
- **params**: `type` (`text` · `textarea` · `code` · `number` · `boolean` · `date` · `select` · `multiselect`), `required`,
  `default`, `min`, `max`, `integer`, `pattern`, `max_length`, `max_items`, `options` (map or list), `show_if`
  (`{ otherParam: value }`; hidden params are never sent), `advanced`, `error`, `template` (accepts host expressions),
  `render` (named renderer for template values).
- **request**: `method`, `path`, `query`, `body`. `{{param}}` placeholders; an empty value drops the query or body key.
- **rules**: `exactly_one_of: [a, b]` with an `error`.
- **output**: `{ key: { path: $.a.b, type, label, item, show_if } }`, types `text` · `number` · `boolean` · `date` ·
  `datetime` · `object` · `list` · `any`.
- **escape hatches**: an operation can use `handler: name` instead of `request`; pass the code in
  `fromManifest(manifest, { handlers, renderers, validators })`.

Every mistake is reported with its location (`bank.operations.transactions.request: unknown placeholder {{ibn}}`).

## Write an integration in TypeScript

```ts
import { z } from 'zod';
import { auth, defineIntegration, field, secret, shape, template } from '@arcanepowered/integrations-sdk';

export const github = defineIntegration({
  id: 'github',
  label: 'GitHub',
  icon: 'Github',
  connection: {
    config: {
      owner: field(z.string().trim().regex(/^[A-Za-z0-9-]{1,39}$/), { label: 'Organization', placeholder: 'acme' }),
    },
    secrets: {
      token: secret(z.string().trim().min(20), {
        label: 'Personal access token',
        help: 'Fine-grained token with read access to issues.',
        message: 'Invalid token',
      }),
    },
  },
  baseUrl: 'https://api.github.com',
  auth: ({ secrets }) => auth.bearer(secrets.token),
  test: ({ http }) => http.get('/user'),
  operations: (op) => ({
    search_issues: op({
      label: 'Search issues',
      description: 'Searches issues of the organization (read only, 100 max).',
      kind: 'read',
      params: {
        query: template(z.string().min(1).max(1000), { label: 'Search query', max: 500, placeholder: 'is:open label:bug' }),
        limit: field(z.number().int().min(1).max(100).default(30), { label: 'Max results', widget: 'number' }),
      },
      output: shape.object({ items: shape.array(shape.object({ title: shape.text(), url: shape.text() }, { open: true })) }),
      outputDoc: '{ items }: issues in the GitHub REST format.',
      run: async ({ http, config }, p) => {
        const res = (await http.get('/search/issues', { query: { q: `org:${config.owner} ${p.query}`, per_page: p.limit } })) as {
          items?: unknown[];
        };
        return { items: res.items ?? [] };
      },
    }),
  }),
});
```

Building blocks:

| Helper | Use |
|---|---|
| `field(schema, meta)` | Any connection or param field. `meta`: `label`, `help`, `placeholder`, `widget`, `inputType`, `options`, `showIf`, `advanced`, `message` (error shown instead of zod's). |
| `secret(schema, meta)` | A connection field that is encrypted by the host and never shown again. The first one provides `keyLast4`. Only allowed in `connection.secrets`. |
| `template(resolved, { max, render? })` | A param that accepts expressions in the host (e.g. `{{ $json.email }}`). `resolved` validates the value once rendered; `render(segments)` escapes inserted data for the target language (JQL, SOQL…). |
| `auth.basic / bearer / header / headers / none` | Return the auth headers and the values to redact from logs. |
| `shape` | Describes the output so hosts can offer autocompletion. |

Rules enforced by `defineIntegration`: ids are `snake_case`, every field is declared with a helper, a key is either config
or secret, `secret()` only in secrets, `template()` only in operation params. Params are a flat object; cross-field rules
go in `check(params) => message | null`.

### Operations

`run({ http, config, secrets, signal }, params)` receives **validated, rendered** params. `http` is bound to `baseUrl` and
the auth headers:

```ts
await http.get('/path', { query: { 'status[]': ['open', 'closed'], page: 2 } });
await http.post('/path', { name: 'x' });
```

Paths must start with `/` and stay under the base URL's origin. Non-2xx answers throw `HttpError` (`status`,
`retryAfter`, first 2 000 characters of `body`); a non-JSON body throws `InvalidResponseError`; guard violations throw
`NetGuardError` (`reason`); oversized bodies throw `ResponseTooLargeError`. Hosts map these to their own messages.

Mark writes with `kind: 'write'` so hosts deduplicate retries.

## Host side

```ts
import { applyTemplates, callOperation, connectionForm, connectionSecretValues, openConnection, parseConnection, testConnection } from '@arcanepowered/integrations-sdk';
import { pinnedFetch, resolveHostAll } from '@arcanepowered/integrations-sdk/node';

const form = connectionForm(github);
const parsed = parseConnection(github, body);
if (!parsed.ok) throw new Error(parsed.message);
await testConnection(github, parsed.value, { fetch: pinnedFetch, resolveHost: resolveHostAll, signal });

const conn = openConnection(github, { config: storedConfig, secrets: decryptedSecrets });
const params = applyTemplates(github.operations.search_issues, storedParams, renderedSegments);
const result = await callOperation(github, 'search_issues', conn, params, { fetch: pinnedFetch, resolveHost: resolveHostAll, signal });
```

`connectionSecretValues(def, conn)` lists every secret value (including derived auth headers) for log redaction.

`pinnedFetch` re-checks the resolved address when the socket connects, which closes the DNS-rebinding window left by a
check-then-fetch.

## Test an integration

```ts
import { mockHttp, runOperation, runTest } from '@arcanepowered/integrations-sdk/testing';

const http = mockHttp((req) => (req.url.pathname === '/search/issues' ? { json: { items: [{ title: 'Bug' }] } } : { status: 404 }));
const out = await runOperation(github, 'search_issues', { query: 'is:open' }, { config: { owner: 'acme' }, secrets: { token: 'x'.repeat(20) }, http });
expect(http.calls[0]?.headers.authorization).toBe(`Bearer ${'x'.repeat(20)}`);
```

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Releases use [changesets](https://github.com/changesets/changesets) and npm trusted publishing with provenance.

## License

[Apache-2.0](./LICENSE)
