import { describe, expect, it } from 'vitest';
import { assertPublicHttpsUrl, guardedFetch, isPublicAddress, NetGuardError, readBodyLimited, ResponseTooLargeError, type FetchLike } from '../src/index.js';

const publicDns = async () => ['93.184.215.14'];

describe('isPublicAddress', () => {
  it.each([
    ['8.8.8.8', true],
    ['93.184.216.34', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['0.0.0.0', false],
    ['10.1.2.3', false],
    ['100.64.0.1', false],
    ['169.254.169.254', false],
    ['172.16.0.1', false],
    ['192.168.1.1', false],
    ['192.0.2.1', false],
    ['224.0.0.1', false],
    ['::', false],
    ['::1', false],
    ['[::1]', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['::ffff:8.8.8.8', true],
    ['64:ff9b::a9fe:a9fe', false],
    ['fc00::1', false],
    ['fe80::1%eth0', false],
    ['ff02::1', false],
    ['2001:db8::1', false],
    ['not-an-ip', false],
  ])('%s -> %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe('assertPublicHttpsUrl', () => {
  it.each([
    ['http://example.com/', 'scheme'],
    ['https://user:pw@example.com/', 'credentials'],
    ['https://example.com:8443/', 'port'],
    ['https://localhost/', 'host'],
    ['https://db.internal/', 'host'],
    ['https://intranet/', 'host'],
    ['https://127.0.0.1/', 'private_address'],
    ['https://[::1]/', 'private_address'],
    ['not a url', 'scheme'],
  ])('%s -> %s', async (url, reason) => {
    await expect(assertPublicHttpsUrl(url, publicDns)).rejects.toMatchObject({ reason });
  });

  it('refuses a host when one resolved address is private, or when DNS fails', async () => {
    await expect(assertPublicHttpsUrl('https://example.com/', async () => ['93.184.215.14', '10.0.0.1'])).rejects.toMatchObject({ reason: 'private_address' });
    await expect(assertPublicHttpsUrl('https://example.com/', async () => [])).rejects.toMatchObject({ reason: 'dns' });
    await expect(
      assertPublicHttpsUrl('https://example.com/', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toMatchObject({ reason: 'dns' });
  });

  it('accepts a public https URL', async () => {
    expect((await assertPublicHttpsUrl('https://example.com/a?b=1', publicDns)).href).toBe('https://example.com/a?b=1');
  });
});

describe('guardedFetch', () => {
  const redirecting = (location: string): FetchLike => {
    let hops = 0;
    return async () => (hops++ === 0 ? new Response(null, { status: 302, headers: { location } }) : new Response('ok'));
  };

  it('refuses redirects by default and follows checked GET redirects when allowed', async () => {
    const signal = new AbortController().signal;
    await expect(guardedFetch(redirecting('https://other.example/'), publicDns, 'https://example.com/', { method: 'GET', headers: {}, signal })).rejects.toMatchObject({ reason: 'redirect' });
    const res = await guardedFetch(redirecting('/next'), publicDns, 'https://example.com/', { method: 'GET', headers: {}, signal, followRedirects: 1 });
    expect(await res.text()).toBe('ok');
    await expect(guardedFetch(redirecting('https://127.0.0.1/'), publicDns, 'https://example.com/', { method: 'GET', headers: {}, signal, followRedirects: 1 })).rejects.toMatchObject({
      reason: 'private_address',
    });
  });

  it('drops sensitive headers on a cross-host redirect', async () => {
    const seen: Array<Record<string, string>> = [];
    let hops = 0;
    const fetchFn: FetchLike = async (_url, init) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return hops++ === 0 ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/x' } }) : new Response('ok');
    };
    await guardedFetch(fetchFn, publicDns, 'https://example.com/', {
      method: 'GET',
      headers: { Authorization: 'Bearer secret', accept: 'application/json' },
      signal: new AbortController().signal,
      sensitiveHeaders: ['authorization'],
      followRedirects: 1,
    });
    expect(seen[0]).toHaveProperty('Authorization');
    expect(seen[1]).not.toHaveProperty('Authorization');
    expect(seen[1]).toHaveProperty('accept');
  });
});

describe('readBodyLimited', () => {
  it('reads up to the limit and refuses larger bodies', async () => {
    expect(await readBodyLimited(new Response('hello'), 10)).toBe('hello');
    await expect(readBodyLimited(new Response('x'.repeat(11)), 10)).rejects.toBeInstanceOf(ResponseTooLargeError);
    await expect(readBodyLimited(new Response('x', { headers: { 'content-length': '99' } }), 10)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('NetGuardError carries a default English message per reason', () => {
    expect(new NetGuardError('port').message).toBe('Only port 443 is allowed');
  });
});
