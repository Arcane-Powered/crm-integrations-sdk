import { guardedFetch, NetGuardError, readBodyLimited, type FetchLike, type HostResolver, type HttpMethod } from './net-guard.js';

export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

export class InvalidResponseError extends Error {
  constructor() {
    super('Response is not valid JSON');
    this.name = 'InvalidResponseError';
  }
}

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>;

export interface HttpRequestOptions {
  query?: Record<string, QueryValue>;
  json?: unknown;
  headers?: Record<string, string>;
  followRedirects?: number;
}

export interface HttpClient {
  request(method: HttpMethod, path: string, opts?: HttpRequestOptions): Promise<unknown>;
  get(path: string, opts?: Omit<HttpRequestOptions, 'json'>): Promise<unknown>;
  post(path: string, json?: unknown, opts?: Omit<HttpRequestOptions, 'json'>): Promise<unknown>;
  put(path: string, json?: unknown, opts?: Omit<HttpRequestOptions, 'json'>): Promise<unknown>;
  patch(path: string, json?: unknown, opts?: Omit<HttpRequestOptions, 'json'>): Promise<unknown>;
  delete(path: string, opts?: Omit<HttpRequestOptions, 'json'>): Promise<unknown>;
}

export interface HttpClientOptions {
  fetch: FetchLike;
  resolveHost: HostResolver;
  baseUrl: string | undefined;
  headers?: Record<string, string>;
  sensitiveHeaders?: readonly string[];
  signal: AbortSignal;
  maxResponseBytes?: number;
}

const ERROR_BODY_CHARS = 2000;

export function resolvePath(baseUrl: string | undefined, path: string): URL {
  if (!baseUrl) throw new NetGuardError('host', 'This integration has no base URL');
  if (!path.startsWith('/') || path.startsWith('//')) throw new NetGuardError('host', 'Paths must be relative to the base URL and start with a single "/"');
  const base = new URL(baseUrl);
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  if (url.origin !== base.origin) throw new NetGuardError('host', 'Path leaves the integration base URL');
  return url;
}

function appendQuery(url: URL, query: Record<string, QueryValue> | undefined): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
    else url.searchParams.set(key, String(value));
  }
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const sensitive = opts.sensitiveHeaders ?? Object.keys(opts.headers ?? {});

  async function request(method: HttpMethod, path: string, ro: HttpRequestOptions = {}): Promise<unknown> {
    const url = resolvePath(opts.baseUrl, path);
    appendQuery(url, ro.query);
    const hasBody = ro.json !== undefined;
    const res = await guardedFetch(opts.fetch, opts.resolveHost, url, {
      method,
      headers: {
        accept: 'application/json',
        ...(ro.headers ?? {}),
        ...(opts.headers ?? {}),
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(ro.json) } : {}),
      signal: opts.signal,
      sensitiveHeaders: sensitive,
      ...(ro.followRedirects !== undefined ? { followRedirects: ro.followRedirects } : {}),
    });
    if (!res.ok) {
      const body = await readBodyLimited(res, maxBytes).catch(() => '');
      throw new HttpError(res.status, res.headers.get('retry-after'), body.slice(0, ERROR_BODY_CHARS));
    }
    const text = await readBodyLimited(res, maxBytes);
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new InvalidResponseError();
    }
  }

  return {
    request,
    get: (path, ro) => request('GET', path, ro),
    post: (path, json, ro) => request('POST', path, { ...ro, json }),
    put: (path, json, ro) => request('PUT', path, { ...ro, json }),
    patch: (path, json, ro) => request('PATCH', path, { ...ro, json }),
    delete: (path, ro) => request('DELETE', path, ro),
  };
}
