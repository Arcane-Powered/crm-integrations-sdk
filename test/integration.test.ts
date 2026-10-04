import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applyTemplates,
  auth,
  connectionForm,
  connectionSecretValues,
  createHttpClient,
  defineIntegration,
  field,
  HttpError,
  IntegrationDefinitionError,
  InvalidResponseError,
  NetGuardError,
  openConnection,
  operationOutput,
  ParamsError,
  parseConnection,
  publicConfig,
  renderTemplate,
  secret,
  shape,
  template,
  templateParams,
  getFieldMeta,
  type TemplateSegment,
} from '../src/index.js';
import { mockHttp, runOperation, runTest } from '../src/testing.js';

const quoted = (segments: readonly TemplateSegment[]) => segments.map((s) => ('text' in s ? s.text : JSON.stringify(String(s.data)))).join('');

const tickets = defineIntegration({
  id: 'tickets',
  label: 'Tickets',
  icon: 'Ticket',
  connection: {
    config: {
      site: field(z.string().trim().regex(/^[a-z]+$/), { label: 'Site', placeholder: 'acme', message: 'Invalid site' }),
    },
    secrets: {
      user: field(z.string().trim().min(1), { label: 'User', inputType: 'email' }),
      token: secret(z.string().trim().min(8), { label: 'Token', message: 'Invalid token' }),
    },
  },
  baseUrl: ({ config }) => `https://${config.site}.tickets.example/api`,
  auth: ({ secrets }) => auth.basic(secrets.user, secrets.token),
  test: ({ http }) => http.get('/me'),
  operations: (op) => ({
    search: op({
      label: 'Search',
      description: 'Search tickets',
      kind: 'read',
      params: {
        query: template(z.string().min(1), { label: 'Query', max: 200, render: quoted }),
        since: template(z.iso.date().optional(), { label: 'Since', max: 50 }),
        status: field(z.enum(['open', 'closed']).optional(), { label: 'Status', widget: 'select' }),
        mine: field(z.boolean().default(false), { label: 'Mine', widget: 'boolean' }),
      },
      check: (p) => (p.mine && p.status === 'closed' ? { param: 'status', message: 'Closed tickets are not assigned' } : null),
      defaults: { mine: false },
      output: (p) => (p.status === 'closed' ? shape.object({ archived: shape.boolean() }) : shape.object({ items: shape.array(shape.unknown()) })),
      outputDoc: '{ items }',
      run: async ({ http }, p) => http.get('/tickets', { query: { q: p.query, since: p.since, status: p.status, tags: ['a', 'b'] } }),
    }),
    create: op({
      label: 'Create',
      description: 'Create a ticket',
      kind: 'write',
      params: { title: field(z.string().min(1), { label: 'Title' }) },
      output: shape.object({ id: shape.text() }),
      outputDoc: '{ id }',
      run: async ({ http }, p) => http.post('/tickets', { title: p.title }),
    }),
  }),
});

const conn = { config: { site: 'acme' }, secrets: { user: 'me@acme.test', token: 'secret-token-1234' } };

describe('defineIntegration', () => {
  it('exposes typed operations with their schemas and template params', () => {
    expect(Object.keys(tickets.operations)).toEqual(['search', 'create']);
    expect(tickets.operations.search.id).toBe('search');
    expect(templateParams(tickets.operations.search)).toEqual(['query', 'since']);
    expect(getFieldMeta(tickets.operations.search.params.query)?.template?.max).toBe(200);
    expect(operationOutput(tickets.operations.search, { status: 'closed' })).toEqual(shape.object({ archived: shape.boolean() }));
  });

  it('rejects malformed definitions', () => {
    const base = { label: 'X', auth: () => auth.none() };
    expect(() => defineIntegration({ ...base, id: 'Bad-Id', connection: { secrets: {} } })).toThrow(IntegrationDefinitionError);
    expect(() => defineIntegration({ ...base, id: 'x', connection: { secrets: { k: z.string() } } })).toThrow(/declare it with field/);
    expect(() => defineIntegration({ ...base, id: 'x', connection: { config: { k: secret(z.string(), { label: 'K' }) }, secrets: {} } })).toThrow(/only allowed in connection.secrets/);
    expect(() => defineIntegration({ ...base, id: 'x', connection: { config: { k: field(z.string(), { label: 'K' }) }, secrets: { k: field(z.string(), { label: 'K' }) } } })).toThrow(/both in config and secrets/);
    expect(() =>
      defineIntegration({ ...base, id: 'x', connection: { secrets: { k: template(z.string(), { label: 'K', max: 10 }) } } }),
    ).toThrow(/only allowed in operation params/);
  });
});

describe('connection', () => {
  it('builds the connection form, config first', () => {
    expect(connectionForm(tickets)).toEqual([
      { key: 'site', group: 'config', label: 'Site', placeholder: 'acme', secret: false, required: true },
      { key: 'user', group: 'secrets', label: 'User', secret: false, required: true, type: 'email' },
      { key: 'token', group: 'secrets', label: 'Token', secret: true, required: true },
    ]);
  });

  it('parses input with field messages and the last 4 characters of the first secret', () => {
    expect(parseConnection(tickets, { site: 'acme', user: ' me@acme.test ', token: 'secret-token-1234' })).toEqual({
      ok: true,
      value: { config: { site: 'acme' }, secrets: { user: 'me@acme.test', token: 'secret-token-1234' }, keyLast4: '1234' },
    });
    expect(parseConnection(tickets, { site: 'ACME!', user: 'u', token: 'secret-token-1234' })).toEqual({ ok: false, field: 'site', message: 'Invalid site' });
    expect(parseConnection(tickets, { site: 'acme', user: 'u', token: 'short' })).toEqual({ ok: false, field: 'token', message: 'Invalid token' });
  });

  it('opens a stored connection and lists every secret value for redaction', () => {
    const opened = openConnection(tickets, conn);
    expect(publicConfig(tickets, opened)).toEqual({ site: 'acme' });
    const values = connectionSecretValues(tickets, opened);
    expect(values).toContain('secret-token-1234');
    expect(values).toContain('me@acme.test:secret-token-1234');
    expect(values).toContain(`Basic ${Buffer.from('me@acme.test:secret-token-1234').toString('base64')}`);
    expect(values).not.toContain('me@acme.test');
    expect(() => openConnection(tickets, { config: {}, secrets: conn.secrets })).toThrow();
  });
});

describe('auth', () => {
  it('builds headers and the values to redact', () => {
    expect(auth.bearer('tok')).toEqual({ headers: { Authorization: 'Bearer tok' }, secretValues: ['tok'] });
    expect(auth.header('X-Key', 'v')).toEqual({ headers: { 'X-Key': 'v' }, secretValues: ['v'] });
    expect(auth.basic('é', 'p').headers.Authorization).toBe(`Basic ${Buffer.from('é:p', 'utf8').toString('base64')}`);
  });
});

describe('templates', () => {
  it('renders with the field render function, or concatenates text and data', () => {
    const segments: TemplateSegment[] = [{ text: 'a = ' }, { data: 'x' }, { text: ' and ' }, { data: { n: 1 } }];
    expect(renderTemplate(getFieldMeta(tickets.operations.search.params.query), segments)).toBe('a = "x" and "[object Object]"');
    expect(renderTemplate(undefined, segments)).toBe('a = x and {"n":1}');
  });

  it('applies templates and drops empty optional ones', () => {
    const out = applyTemplates(tickets.operations.search, { query: 'raw', since: 'raw', mine: true }, { query: [{ text: 'q ' }, { data: 'x' }], since: [{ text: '  ' }] });
    expect(out).toEqual({ query: 'q "x"', mine: true });
  });
});

describe('http client', () => {
  it('stays under the base URL origin', async () => {
    const http = mockHttp(() => ({ json: {} }));
    const client = createHttpClient({ ...http, baseUrl: 'https://api.example/v2', signal: new AbortController().signal });
    await client.get('/a/b');
    expect(http.calls[0]?.url.href).toBe('https://api.example/v2/a/b');
    await expect(client.get('https://evil.example/')).rejects.toBeInstanceOf(NetGuardError);
    await expect(client.get('//evil.example/')).rejects.toBeInstanceOf(NetGuardError);
    await expect(createHttpClient({ ...http, baseUrl: undefined, signal: new AbortController().signal }).get('/x')).rejects.toBeInstanceOf(NetGuardError);
  });

  it('throws HttpError with status, Retry-After and body, InvalidResponseError on non-JSON', async () => {
    const http = mockHttp((req) =>
      req.url.pathname === '/limited' ? { status: 429, json: { error: 'slow down' }, headers: { 'retry-after': '7' } } : { text: '<html>' },
    );
    const client = createHttpClient({ ...http, baseUrl: 'https://api.example', signal: new AbortController().signal });
    const err = await client.get('/limited').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 429, retryAfter: '7', body: '{"error":"slow down"}' });
    await expect(client.get('/html')).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe('testing helpers', () => {
  it('runs an operation end to end with auth, query and validation', async () => {
    const http = mockHttp((req) => (req.url.pathname === '/api/tickets' ? { json: { items: [1] } } : { status: 404 }));
    const out = await runOperation(tickets, 'search', { query: 'bug', since: '2026-10-01' }, { ...conn, http });
    expect(out).toEqual({ items: [1] });
    const call = http.calls[0]!;
    expect(call.url.origin).toBe('https://acme.tickets.example');
    expect([...call.url.searchParams.entries()]).toEqual([
      ['q', 'bug'],
      ['since', '2026-10-01'],
      ['tags', 'a'],
      ['tags', 'b'],
    ]);
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from('me@acme.test:secret-token-1234').toString('base64')}`);
  });

  it('validates params and the cross-field check before any request', async () => {
    const http = mockHttp(() => ({ json: {} }));
    await expect(runOperation(tickets, 'search', { query: 'x', since: 'tomorrow' }, { ...conn, http })).rejects.toMatchObject({ name: 'ParamsError', field: 'since' });
    const err = await runOperation(tickets, 'search', { query: 'x', mine: true, status: 'closed' }, { ...conn, http }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParamsError);
    expect(err).toMatchObject({ field: 'status', message: 'Closed tickets are not assigned' });
    await expect(runOperation(tickets, 'nope', {}, { ...conn, http })).rejects.toThrow(/Unknown operation/);
    expect(http.calls).toEqual([]);
  });

  it('posts JSON for writes and tests the connection', async () => {
    const http = mockHttp((req) => (req.method === 'POST' ? { json: { id: 't1' } } : { json: { me: true } }));
    expect(await runOperation(tickets, 'create', { title: 'Bug' }, { ...conn, http })).toEqual({ id: 't1' });
    expect(http.calls[0]).toMatchObject({ method: 'POST', body: { title: 'Bug' } });
    expect(http.calls[0]?.headers['content-type']).toBe('application/json');
    expect(await runTest(tickets, { ...conn, http })).toEqual({ status: 'ok' });
    expect(http.calls[1]?.url.pathname).toBe('/api/me');
  });

  it('reports skipped when an integration has no test', async () => {
    const plain = defineIntegration({ id: 'plain', label: 'Plain', connection: { secrets: { key: secret(z.string(), { label: 'Key' }) } }, auth: ({ secrets }) => auth.header('X-Key', secrets.key) });
    expect(await runTest(plain, { secrets: { key: 'k' }, http: mockHttp(() => ({})) })).toEqual({ status: 'skipped' });
  });
});
