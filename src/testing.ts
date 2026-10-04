import type { Integration } from './define.js';
import type { FetchLike, HostResolver } from './net-guard.js';
import { callOperation, testConnection, type TestConnectionResult } from './run.js';

export interface MockRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type MockHandler = (req: MockRequest) => MockResponse | Promise<MockResponse>;

export interface MockHttp {
  fetch: FetchLike;
  resolveHost: HostResolver;
  calls: MockRequest[];
}

export const PUBLIC_TEST_ADDRESS = '93.184.215.14';

export function mockHttp(handler: MockHandler): MockHttp {
  const calls: MockRequest[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const rawBody = typeof init.body === 'string' ? init.body : undefined;
    let body: unknown = rawBody;
    if (rawBody !== undefined) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const req: MockRequest = { method: (init.method ?? 'GET').toUpperCase(), url: new URL(String(input)), headers, body };
    calls.push(req);
    const res = await handler(req);
    const text = res.text ?? (res.json !== undefined ? JSON.stringify(res.json) : '');
    return new Response(text === '' ? null : text, {
      status: res.status ?? 200,
      headers: { ...(res.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(res.headers ?? {}) },
    });
  };
  return { fetch, resolveHost: async () => [PUBLIC_TEST_ADDRESS], calls };
}

export interface RunOptions {
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  http: MockHttp;
  signal?: AbortSignal;
}

function connectionOf(def: Integration, opts: RunOptions) {
  return { config: def.config.parse(opts.config ?? {}), secrets: def.secrets.parse(opts.secrets ?? {}) };
}

export function runOperation(def: Integration, operationId: string, params: Record<string, unknown>, opts: RunOptions): Promise<unknown> {
  return callOperation(def, operationId, connectionOf(def, opts), params, {
    fetch: opts.http.fetch,
    resolveHost: opts.http.resolveHost,
    signal: opts.signal ?? new AbortController().signal,
  });
}

export function runTest(def: Integration, opts: RunOptions): Promise<TestConnectionResult> {
  return testConnection(def, connectionOf(def, opts), {
    fetch: opts.http.fetch,
    resolveHost: opts.http.resolveHost,
    signal: opts.signal ?? new AbortController().signal,
  });
}
