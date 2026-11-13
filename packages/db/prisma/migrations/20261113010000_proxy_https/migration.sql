-- Plan 0004 phase 6: HTTP proxies reached over TLS. Adds an enum value; nothing existing changes.
ALTER TYPE "ProxyProtocol" ADD VALUE 'https';
