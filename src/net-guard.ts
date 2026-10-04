export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type HostResolver = (hostname: string) => Promise<string[]>;

export type NetGuardReason = 'scheme' | 'credentials' | 'port' | 'host' | 'private_address' | 'dns' | 'redirect';

const REASON_MESSAGES: Record<NetGuardReason, string> = {
  scheme: 'Only https URLs are allowed',
  credentials: 'Credentials are not allowed in the URL',
  port: 'Only port 443 is allowed',
  host: 'Internal host refused',
  private_address: 'Local or private address refused',
  dns: 'Host name not found',
  redirect: 'Redirect refused',
};

export class NetGuardError extends Error {
  constructor(
    readonly reason: NetGuardReason,
    message: string = REASON_MESSAGES[reason],
  ) {
    super(message);
    this.name = 'NetGuardError';
  }
}

function parseIpv4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

function isPublicIpv4(p: number[]): boolean {
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function parseIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(':')) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseIpv4(last);
    if (!v4) return null;
    tail = [((v4[0] as number) << 8) | (v4[1] as number), ((v4[2] as number) << 8) | (v4[3] as number)];
    const prefix = s.slice(0, lastColon + 1);
    s = prefix.endsWith('::') ? prefix : prefix.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toWords = (part: string) => (part === '' ? [] : part.split(':').map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN)));
  const head = toWords(halves[0] as string);
  const rest = halves.length === 2 ? toWords(halves[1] as string) : [];
  if ([...head, ...rest].some((w) => Number.isNaN(w))) return null;
  const total = head.length + rest.length + tail.length;
  if (halves.length === 1 && total !== 8) return null;
  if (total > 8) return null;
  const zeros = halves.length === 2 ? new Array(8 - total).fill(0) : [];
  return [...head, ...zeros, ...rest, ...tail];
}

function isPublicIpv6(w: number[]): boolean {
  const [w0, w1, w2, w3, w4, w5, w6, w7] = w as [number, number, number, number, number, number, number, number];
  if (w.every((x) => x === 0)) return false;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) return false;
  const embedded = [w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff];
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && (w5 === 0xffff || w5 === 0)) return isPublicIpv4(embedded);
  if (w0 === 0x64 && w1 === 0xff9b) return isPublicIpv4(embedded);
  if ((w0 & 0xfe00) === 0xfc00) return false;
  if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) return false;
  if ((w0 & 0xff00) === 0xff00) return false;
  if (w0 === 0x2001 && w1 === 0x0db8) return false;
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return false;
  return true;
}

export function isPublicAddress(ip: string): boolean {
  const v4 = parseIpv4(ip.trim());
  if (v4) return isPublicIpv4(v4);
  const v6 = parseIpv6(ip.trim());
  if (v6) return isPublicIpv6(v6);
  return false;
}

const INTERNAL_NAME = /(?:^|\.)(?:localhost|local|internal|lan|home|corp|intranet|localdomain|home\.arpa)$/i;

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

export async function assertPublicHttpsUrl(raw: string | URL, resolve: HostResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new NetGuardError('scheme', 'Invalid URL');
  }
  if (url.protocol !== 'https:') throw new NetGuardError('scheme');
  if (url.username || url.password) throw new NetGuardError('credentials');
  if (url.port && url.port !== '443') throw new NetGuardError('port');
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (!host || INTERNAL_NAME.test(host)) throw new NetGuardError('host');
  if (isIpLiteral(host)) {
    if (!isPublicAddress(host)) throw new NetGuardError('private_address');
    return url;
  }
  if (!host.includes('.')) throw new NetGuardError('host');
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new NetGuardError('dns');
  }
  if (addresses.length === 0) throw new NetGuardError('dns');
  if (addresses.some((a) => !isPublicAddress(a))) throw new NetGuardError('private_address');
  return url;
}

export class ResponseTooLargeError extends Error {
  constructor() {
    super('Response too large');
    this.name = 'ResponseTooLargeError';
  }
}

export async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface GuardedFetchOptions {
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  sensitiveHeaders?: readonly string[];
  followRedirects?: number;
}

export async function guardedFetch(fetchFn: FetchLike, resolve: HostResolver, rawUrl: string | URL, opts: GuardedFetchOptions): Promise<Response> {
  let url = await assertPublicHttpsUrl(rawUrl, resolve);
  const originHost = url.host;
  let headers = { ...opts.headers };
  const maxHops = opts.method === 'GET' ? Math.max(0, opts.followRedirects ?? 0) : 0;
  for (let hop = 0; ; hop++) {
    const res = await fetchFn(url, {
      method: opts.method,
      headers,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      redirect: 'manual',
      signal: opts.signal,
    });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get('location');
    if (!location || hop >= maxHops) throw new NetGuardError('redirect');
    const next = await assertPublicHttpsUrl(new URL(location, url), resolve);
    if (next.host !== originHost) {
      const drop = new Set((opts.sensitiveHeaders ?? []).map((h) => h.toLowerCase()));
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())));
    }
    url = next;
  }
}
