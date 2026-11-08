import { describe, expect, it } from 'vitest';
import { parseProxyUrl } from './add-proxy';

describe('add-proxy parseProxyUrl', () => {
  it('splits an http proxy URL and decodes the login', () => {
    expect(parseProxyUrl('http://us%40er:p%3Ass@isp.example.com:10006')).toEqual({
      protocol: 'http',
      host: 'isp.example.com',
      port: 10006,
      username: 'us@er',
      password: 'p:ss',
    });
  });
  it('accepts socks5h as socks5 and no login', () => {
    expect(parseProxyUrl('socks5h://10.0.0.1:1080')).toMatchObject({ protocol: 'socks5', username: null });
  });
  it('refuses other schemes, missing ports and garbage without echoing the input', () => {
    expect(() => parseProxyUrl('https://a:b@h:1')).toThrow(/unsupported proxy scheme https$/);
    expect(() => parseProxyUrl('http://h')).toThrow(/host and a port/);
    expect(() => parseProxyUrl('secret-not-a-url')).toThrow(/^not a proxy URL/);
  });
});
