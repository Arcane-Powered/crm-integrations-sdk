import { lookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { isPublicAddress, NetGuardError, type FetchLike, type HostResolver } from './net-guard.js';

export const resolveHostAll: HostResolver = (hostname) =>
  new Promise((resolve, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses.map((a) => a.address))));
  });

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      const refused = new NetGuardError('private_address');
      return callback(Object.assign(refused, { code: 'EGUARD_PRIVATE_ADDRESS' }) as NodeJS.ErrnoException, '');
    }
    if (options.all) return callback(null, list);
    const first = list[0] as LookupAddress;
    return callback(null, first.address, first.family);
  });
}

function headerRecord(init: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export const pinnedFetch: FetchLike = (input, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(String(input));
    } catch {
      reject(new NetGuardError('scheme', 'Invalid URL'));
      return;
    }
    if (url.protocol !== 'https:') {
      reject(new NetGuardError('scheme'));
      return;
    }
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = { 'accept-encoding': 'identity', ...headerRecord(init.headers) };
    const body = typeof init.body === 'string' ? init.body : init.body == null ? undefined : String(init.body);
    if (body !== undefined && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const req = httpsRequest(url, { method, headers, lookup: guardedLookup as never, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v);
        else if (value !== undefined) responseHeaders.set(key, String(value));
      }
      const status = res.statusCode ?? 502;
      const empty = NULL_BODY_STATUS.has(status) || method === 'HEAD';
      if (empty) res.resume();
      try {
        resolve(new Response(empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? '', headers: responseHeaders }));
      } catch (err) {
        res.destroy();
        reject(err);
      }
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
