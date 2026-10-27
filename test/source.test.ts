import { describe, expect, it } from 'vitest';
import { defineIntegration, fromManifest, IntegrationDefinitionError, readSource, sourceValue, UnknownSourceError, type IntegrationManifest } from '../src/index.js';
import { mockHttp, runSource } from '../src/testing.js';

const crm: IntegrationManifest = {
  id: 'crm',
  label: 'CRM',
  base_url: 'https://api.crm.example',
  connection: { token: { label: 'Token', secret: true } },
  auth: { bearer: '{{token}}' },
  sources: {
    people: {
      label: 'People',
      target: 'crm_contacts',
      list: {
        request: { path: '/people', query: { limit: 2, fields: ['email', 'name'], after: '{{cursor}}' } },
        items: '$.results',
        next: '$.paging.next',
      },
      changes: {
        request: {
          method: 'POST',
          path: '/people/search',
          body: { filters: [{ field: 'updated', gte: '{{since}}' }], after: '{{cursor}}' },
        },
        items: '$.results',
        next: '$.paging.next',
      },
      since: 'unix_ms',
      id: '$.id',
      updated_at: '$.updatedAt',
      fields: {
        email: { path: '$.emails.0.value', label: 'E-mail' },
        name: { path: '$.props.name', label: 'Name' },
        tags: { path: '$.props.tags', label: 'Tags' },
      },
    },
  },
};

const sheet: IntegrationManifest = {
  id: 'sheet',
  label: 'Sheet',
  base_url: 'https://api.sheet.example',
  connection: { base: { label: 'Base' }, token: { label: 'Token', secret: true } },
  auth: { bearer: '{{token}}' },
  sources: {
    rows: {
      label: 'Rows',
      list: { request: { path: '/v0/{{base}}/rows', query: { offset: '{{cursor}}' } }, items: '$.records', next: '$.offset' },
      changes: { request: { path: '/v0/{{base}}/rows', query: { offset: '{{cursor}}', filter: "IS_AFTER(MODIFIED(), '{{since}}')" } }, items: '$.records', next: '$.offset' },
      id: '$.id',
      fields_from: '$.fields',
    },
  },
};

const secrets = { token: 'tok-123' };

describe('manifest sources', () => {
  it('pages through a full list with the cursor and normalizes items', async () => {
    const integration = fromManifest(crm);
    const http = mockHttp((req) => {
      const after = req.url.searchParams.get('after');
      if (!after)
        return {
          json: {
            results: [
              { id: 1, updatedAt: '2026-10-01T10:00:00Z', emails: [{ value: 'ada@acme.io' }], props: { name: 'Ada', tags: ['vip', 'eu'] } },
              { props: { name: 'No id' } },
            ],
            paging: { next: 'p2' },
          },
        };
      return { json: { results: [{ id: 'b', props: { name: '  ', tags: [{ x: 1 }] } }], paging: {} } };
    });
    const first = await runSource(integration, 'people', { mode: 'full' }, { secrets, http });
    expect(first).toEqual({
      items: [{ id: '1', updatedAt: '2026-10-01T10:00:00.000Z', fields: { email: 'ada@acme.io', name: 'Ada', tags: 'vip, eu' } }],
      next: 'p2',
    });
    const second = await runSource(integration, 'people', { mode: 'full', cursor: 'p2' }, { secrets, http });
    expect(second).toEqual({ items: [{ id: 'b', updatedAt: null, fields: {} }], next: null });
    expect(http.calls[0]!.url.searchParams.getAll('fields')).toEqual(['email', 'name']);
    expect(http.calls[0]!.url.searchParams.has('after')).toBe(false);
    expect(http.calls[0]!.headers.authorization).toBe('Bearer tok-123');
    expect(http.calls[1]!.url.searchParams.get('after')).toBe('p2');
    expect(integration.sources.people).toMatchObject({ label: 'People', target: 'crm_contacts', incremental: true, fields: [{ key: 'email', label: 'E-mail' }, { key: 'name', label: 'Name' }, { key: 'tags', label: 'Tags' }] });
  });

  it('lists changes since a date, rendered in the declared format inside a nested body', async () => {
    const http = mockHttp(() => ({ json: { results: [], paging: { next: 'same' } } }));
    const page = await runSource(fromManifest(crm), 'people', { mode: 'changes', since: '2026-10-27T08:00:00Z', cursor: 'same' }, { secrets, http });
    expect(page).toEqual({ items: [], next: null });
    expect(http.calls[0]!.method).toBe('POST');
    expect(http.calls[0]!.body).toEqual({ filters: [{ field: 'updated', gte: String(Date.parse('2026-10-27T08:00:00Z')) }], after: 'same' });
  });

  it('reads dynamic fields and puts public connection values in the path', async () => {
    const integration = fromManifest(sheet);
    expect(integration.sources.rows).toMatchObject({ fields: [], dynamicFields: true, incremental: true });
    const http = mockHttp(() => ({ json: { records: [{ id: 'rec1', fields: { Name: 'Ada', Age: 36, Active: true, Photo: [{ url: 'x' }] } }] } }));
    const page = await runSource(integration, 'rows', { mode: 'changes', since: '2026-10-27T08:00:00.123Z' }, { config: { base: 'app 1' }, secrets, http });
    expect(page.items).toEqual([{ id: 'rec1', updatedAt: null, fields: { Name: 'Ada', Age: 36, Active: true } }]);
    expect(http.calls[0]!.url.pathname).toBe('/v0/app%201/rows');
    expect(http.calls[0]!.url.searchParams.get('filter')).toBe("IS_AFTER(MODIFIED(), '2026-10-27T08:00:00Z')");
  });

  it('refuses changes without since, unknown sources and changes on a list-only source', async () => {
    const http = mockHttp(() => ({ json: {} }));
    const integration = fromManifest(crm);
    await expect(runSource(integration, 'people', { mode: 'changes' }, { secrets, http })).rejects.toThrow('"since" is required');
    await expect(runSource(integration, 'nope', { mode: 'full' }, { secrets, http })).rejects.toBeInstanceOf(UnknownSourceError);
    const listOnly = fromManifest({ ...crm, sources: { people: { ...crm.sources!.people!, changes: undefined } } });
    expect(listOnly.sources.people!.incremental).toBe(false);
    await expect(runSource(listOnly, 'people', { mode: 'changes', since: '2026-10-27T08:00:00Z' }, { secrets, http })).rejects.toThrow('cannot list changes');
  });

  it('fails on a response without the items array, drops a key with an empty placeholder, ignores out-of-range dates', async () => {
    const mixed = fromManifest({ ...sheet, sources: { rows: { ...sheet.sources!.rows!, list: { request: { path: '/v0/{{base}}/rows', query: { page: '{{base}}:{{cursor}}' } }, items: '$.records', next: '$.offset' }, updated_at: '$.at' } } });
    const http = mockHttp((req) => (req.url.searchParams.has('page') ? { json: { nope: [] } } : { json: { records: [{ id: 'r', at: 8.64e15 + 1, fields: {} }] } }));
    const page = await runSource(mixed, 'rows', { mode: 'full' }, { config: { base: 'b' }, secrets, http });
    expect(http.calls[0]!.url.searchParams.has('page')).toBe(false);
    expect(page.items).toEqual([{ id: 'r', updatedAt: null, fields: {} }]);
    await expect(runSource(mixed, 'rows', { mode: 'full', cursor: 'c2' }, { config: { base: 'b' }, secrets, http })).rejects.toThrow('Source response has no array at "$.records"');
  });

  it('reports source mistakes with their location', () => {
    const people = crm.sources!.people!;
    const bad = (patch: Record<string, unknown>) => () => fromManifest({ ...crm, sources: { people: { ...people, ...patch } } });
    expect(bad({ list: { ...people.list, next: undefined } })).toThrow('crm.sources.people.list: {{cursor}} needs "next"');
    expect(bad({ list: { request: { path: '/people' }, items: '$.results', next: '$.next' } })).toThrow('crm.sources.people.list: "next" needs a {{cursor}} placeholder');
    expect(bad({ list: { request: { path: '/people', query: { s: '{{since}}' } }, items: '$.r' } })).toThrow('crm.sources.people.list: {{since}} is only allowed in "changes"');
    expect(bad({ changes: { request: { path: '/people' }, items: '$.r' } })).toThrow('crm.sources.people.changes: changes need a {{since}} placeholder');
    expect(bad({ list: { request: { path: '/{{token}}' }, items: '$.r' } })).toThrow('unknown placeholder {{token}}');
    expect(bad({ fields_from: '$.fields' })).toThrow(IntegrationDefinitionError);
    expect(bad({ fields: undefined })).toThrow('declare either "fields" or "fields_from"');
  });

  it('accepts hand-written sources in TypeScript', async () => {
    const def = defineIntegration({
      id: 'custom',
      label: 'Custom',
      connection: { secrets: {} },
      auth: () => ({ headers: {}, secretValues: [] }),
      sources: { all: { label: 'All', fields: [{ key: 'a', label: 'A' }], incremental: false, read: async () => ({ items: [{ id: '1', updatedAt: null, fields: { a: 1 } }], next: null }) } },
    });
    const page = await readSource(def, 'all', { config: {}, secrets: {} }, { mode: 'full' }, { ...mockHttp(() => ({})), signal: new AbortController().signal });
    expect(page.items[0]!.fields).toEqual({ a: 1 });
    expect(() => defineIntegration({ id: 'x', label: 'X', connection: { secrets: {} }, auth: () => ({ headers: {}, secretValues: [] }), sources: { 'Bad-Id': { label: 'B', fields: [], incremental: false, read: async () => ({ items: [], next: null }) } } })).toThrow('invalid source id "Bad-Id"');
  });

  it('turns values into scalars', () => {
    expect(sourceValue('a')).toBe('a');
    expect(sourceValue('')).toBeUndefined();
    expect(sourceValue(Number.NaN)).toBeUndefined();
    expect(sourceValue([1, 'b', true])).toBe('1, b, true');
    expect(sourceValue([1, { a: 1 }])).toBeUndefined();
    expect(sourceValue({ a: 1 })).toBeUndefined();
    expect(sourceValue(null)).toBeUndefined();
  });
});
