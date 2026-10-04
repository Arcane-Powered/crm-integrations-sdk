import { describe, expect, it } from 'vitest';
import { connectionForm, fromManifest, IntegrationDefinitionError, operationOutput, parseConnection, shape, templateParams, type IntegrationManifest, type ManifestHooks } from '../src/index.js';
import { mockHttp, runOperation, runTest } from '../src/testing.js';

const bank: IntegrationManifest = {
  id: 'bank',
  label: 'Bank',
  icon: 'Landmark',
  base_url: 'https://{{site}}.bank.example/v2',
  connection: {
    site: { label: 'Site', pattern: '^[a-z]+$', error: 'Invalid site' },
    login: { label: 'Login', private: true },
    key: { label: 'Key', secret: true, pattern: '^\\S{8,}$', error: 'Invalid key' },
  },
  auth: { header: { name: 'Authorization', value: '{{login}}:{{key}}' } },
  test: 'GET /me',
  operations: {
    read: {
      label: 'Read',
      description: 'Reads the account or its transactions',
      params: {
        what: { label: 'What', type: 'select', options: { account: 'Account', transactions: 'Transactions' }, default: 'account' },
        accountId: { label: 'Account id', pattern: '^[a-z0-9]+$', show_if: { what: 'transactions' } },
        iban: { label: 'IBAN', show_if: { what: 'transactions' } },
        status: { label: 'Status', type: 'select', options: ['open', 'done'], show_if: { what: 'transactions' } },
        since: { label: 'Since', type: 'date', template: true, show_if: { what: 'transactions' } },
        page: { label: 'Page', type: 'number', min: 1, default: 1, show_if: { what: 'transactions' } },
      },
      rules: [{ exactly_one_of: ['accountId', 'iban'], error: 'Account id or IBAN, not both' }],
      request: {
        path: '/{{what}}',
        query: { account_id: '{{accountId}}', iban: '{{iban}}', 'status[]': '{{status}}', since: '{{since}}', page: '{{page}}' },
      },
      output: {
        account: { path: '$.account', type: 'object', show_if: { what: 'account' } },
        items: { path: '$.transactions', type: 'list', item: 'object', label: 'Transactions', show_if: { what: 'transactions' } },
        total: { path: '$.meta.total', type: 'number', show_if: { what: 'transactions' } },
      },
      output_doc: '{ account } or { items, total }',
    },
    search: {
      label: 'Search',
      description: 'Search with a custom handler',
      params: { q: { label: 'Query', type: 'code', template: true, required: true, render: 'quoted', max_length: 100 } },
      handler: 'search',
      output: { items: { type: 'list', item: { id: 'text' } } },
      output_doc: '{ items }',
    },
  },
};

const hooks = {
  handlers: { search: async (_ctx: unknown, p: Record<string, unknown>) => ({ items: [{ id: p.q }] }) },
  renderers: { quoted: (segments: ReadonlyArray<{ text: string } | { data: unknown }>) => segments.map((s) => ('text' in s ? s.text : `"${String(s.data)}"`)).join('') },
};

const conn = { config: { site: 'acme' }, secrets: { login: 'me', key: 'secret-key-1234' } };

describe('fromManifest', () => {
  const integration = fromManifest(bank, hooks);

  it('splits connection fields: plain -> config, private and secret -> encrypted secrets', () => {
    expect(connectionForm(integration).map((f) => [f.key, f.group, f.secret])).toEqual([
      ['site', 'config', false],
      ['login', 'secrets', false],
      ['key', 'secrets', true],
    ]);
    expect(parseConnection(integration, { site: 'acme', login: 'me', key: 'secret-key-1234' })).toMatchObject({ ok: true, value: { keyLast4: '1234' } });
    expect(parseConnection(integration, { site: 'ACME', login: 'me', key: 'secret-key-1234' })).toEqual({ ok: false, field: 'site', message: 'Invalid site' });
    expect(parseConnection(integration, { site: 'acme', login: 'me', key: 'short' })).toMatchObject({ ok: false, field: 'key', message: 'Invalid key' });
  });

  it('runs a declarative request: base URL, auth, path and query placeholders, hidden params dropped', async () => {
    const http = mockHttp(() => ({ json: { transactions: [{ a: 1 }, 'x'], meta: { total: 1 } } }));
    const out = await runOperation(integration, 'read', { what: 'transactions', iban: 'FR76', status: 'done', since: '2026-10-01' }, { ...conn, http });
    expect(out).toEqual({ items: [{ a: 1 }], total: 1 });
    const call = http.calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe('https://acme.bank.example/v2/transactions');
    expect([...call.url.searchParams.entries()]).toEqual([
      ['iban', 'FR76'],
      ['status[]', 'done'],
      ['since', '2026-10-01'],
      ['page', '1'],
    ]);
    expect(call.headers.authorization).toBe('me:secret-key-1234');

    const acc = mockHttp(() => ({ json: { account: { id: 'a' } } }));
    expect(await runOperation(integration, 'read', {}, { ...conn, http: acc })).toEqual({ account: { id: 'a' } });
    expect(acc.calls[0]!.url.href).toBe('https://acme.bank.example/v2/account');
  });

  it('applies rules and typed params before any request', async () => {
    const http = mockHttp(() => ({ json: {} }));
    await expect(runOperation(integration, 'read', { what: 'transactions' }, { ...conn, http })).rejects.toMatchObject({ field: 'accountId', message: 'Account id or IBAN, not both' });
    await expect(runOperation(integration, 'read', { what: 'transactions', iban: 'x', since: 'tomorrow' }, { ...conn, http })).rejects.toMatchObject({ field: 'since' });
    await expect(runOperation(integration, 'read', { what: 'other' }, { ...conn, http })).rejects.toMatchObject({ field: 'what' });
    expect(http.calls).toEqual([]);
  });

  it('exposes template params, defaults and a params-dependent output shape', () => {
    const read = integration.operations.read!;
    expect(templateParams(read)).toEqual(['since']);
    expect(read.defaults).toEqual({ what: 'account', page: 1 });
    expect(operationOutput(read, { what: 'account' })).toEqual(shape.object({ account: shape.object({}, { open: true }) }));
    expect(operationOutput(read, { what: 'transactions' })).toEqual(
      shape.object({ items: shape.array(shape.object({}, { open: true }), 'Transactions'), total: { kind: 'scalar', type: 'number' } }),
    );
  });

  it('delegates to a named handler and renderer', async () => {
    const out = await runOperation(integration, 'search', { q: 'bug' }, { ...conn, http: mockHttp(() => ({})) });
    expect(out).toEqual({ items: [{ id: 'bug' }] });
    expect(templateParams(integration.operations.search!)).toEqual(['q']);
  });

  it('tests the connection with the declared request', async () => {
    const http = mockHttp(() => ({ json: {} }));
    expect(await runTest(integration, { ...conn, http })).toEqual({ status: 'ok' });
    expect(http.calls[0]!.url.href).toBe('https://acme.bank.example/v2/me');
  });

  it('reports manifest mistakes with their location', () => {
    const bad = (patch: Partial<IntegrationManifest>, h: ManifestHooks = hooks) => () => fromManifest({ ...bank, ...patch }, h);
    expect(bad({ id: 'Bank!' })).toThrow(IntegrationDefinitionError);
    expect(bad({ base_url: 'https://{{nope}}.example' })).toThrow(/bank.base_url: unknown placeholder \{\{nope\}\}/);
    expect(bad({}, { ...hooks, handlers: {} })).toThrow(/handler "search" is not provided/);
    expect(() => fromManifest({ ...bank, operations: { x: { label: 'X', description: 'X', output: {}, output_doc: 'x' } } })).toThrow(/either "request" or "handler"/);
    expect(() => fromManifest({ id: 'x', label: 'X', unknown: true })).toThrow(/Invalid integration manifest/);
  });
});
