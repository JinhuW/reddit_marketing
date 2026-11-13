import { describe, expect, it } from 'vitest';
import { PROXY_PASTE_MAX, parseProxyLines } from './proxy-parse';

describe('parseProxyLines', () => {
  it('reads the forms vendors hand out', () => {
    const r = parseProxyLines(
      [
        '# my list',
        '',
        '203.0.113.5:8080',
        'gate.example.com:7000:user-1:p:a:ss',
        'user2:pw2@gate.example.com:7001',
        'socks5://u3:p%40ss@198.51.100.7:1080',
        'http://gate.example.com:9000',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(r.proxies).toEqual([
      {
        protocol: 'http',
        host: '203.0.113.5',
        port: 8080,
        username: null,
        password: null,
        note: null,
        refreshUrl: null,
      },
      {
        protocol: 'http',
        host: 'gate.example.com',
        port: 7000,
        username: 'user-1',
        password: 'p:a:ss',
        note: null,
        refreshUrl: null,
      },
      {
        protocol: 'http',
        host: 'gate.example.com',
        port: 7001,
        username: 'user2',
        password: 'pw2',
        note: null,
        refreshUrl: null,
      },
      {
        protocol: 'socks5',
        host: '198.51.100.7',
        port: 1080,
        username: 'u3',
        password: 'p@ss',
        note: null,
        refreshUrl: null,
      },
      {
        protocol: 'http',
        host: 'gate.example.com',
        port: 9000,
        username: null,
        password: null,
        note: null,
        refreshUrl: null,
      },
    ]);
  });

  it('takes a note and a change-IP link in either order, and the fallback protocol', () => {
    const r = parseProxyLines(
      'm.example.com:5000:u:p{US mobile 3}[https://vendor.example/rotate?token=abc]\n' +
        '[http://vendor.example/r/9] socks5h://m2.example.com:5001 { second }',
      'socks5',
    );
    expect(r.errors).toEqual([]);
    expect(r.proxies[0]).toMatchObject({
      protocol: 'socks5',
      host: 'm.example.com',
      note: 'US mobile 3',
      refreshUrl: 'https://vendor.example/rotate?token=abc',
    });
    expect(r.proxies[1]).toMatchObject({
      protocol: 'socks5',
      host: 'm2.example.com',
      port: 5001,
      note: 'second',
      refreshUrl: 'http://vendor.example/r/9',
    });
  });

  it('reports bad lines by number without echoing what was on them', () => {
    const r = parseProxyLines(
      'good.example.com:80\nnot a proxy secret-pass\nftp://x:1\nhost:99999\na:b@h.example:1:c:d',
    );
    expect(r.proxies).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(JSON.stringify(r.errors)).not.toContain('secret-pass');
    expect(r.errors[1]?.reason).toContain('unsupported scheme');
  });

  it('caps one paste', () => {
    const many = Array.from({ length: PROXY_PASTE_MAX + 5 }, (_, i) => `h${i}.example.com:80`).join('\n');
    const r = parseProxyLines(many);
    expect(r.proxies).toHaveLength(PROXY_PASTE_MAX);
    expect(r.errors).toHaveLength(1);
  });
});

describe('https proxies (plan 0004 phase 6)', () => {
  it('reads the https scheme and takes it as the fallback', () => {
    const r = parseProxyLines('https://u:p@gate.example.com:8443\nplain.example.com:8443', 'https');
    expect(r.errors).toEqual([]);
    expect(r.proxies.map((p) => [p.protocol, p.host, p.port])).toEqual([
      ['https', 'gate.example.com', 8443],
      ['https', 'plain.example.com', 8443],
    ]);
  });
});
