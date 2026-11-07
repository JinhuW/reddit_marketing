// Static checks on the image recipe: the license key only ever arrives as a BuildKit secret, the build is pinned,
// and the image copies everything the supervisor imports.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..');
const dockerfile = readFileSync(join(dir, 'Dockerfile'), 'utf8');
const instructions = dockerfile
  .replace(/\\\n/g, ' ')
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('#'));

describe('Dockerfile', () => {
  it('never puts the license key in an ARG, ENV or LABEL', () => {
    for (const line of instructions) {
      if (/^\s*(ARG|ENV|LABEL)\b/.test(line)) expect(line).not.toMatch(/LICENSE|KEY|SECRET|TOKEN/i);
    }
  });

  it('reads the key only from the cloak_key BuildKit secret', () => {
    expect(dockerfile).toContain('--mount=type=secret,id=cloak_key,required=false');
    expect(dockerfile).not.toMatch(/COPY[^\n]*(key|secret)/i);
  });

  it('pins one CloakBrowser build and refuses non-amd64 platforms', () => {
    expect(dockerfile).toMatch(/ARG CLOAK_VERSION\n/);
    expect(dockerfile).toContain('CLOAK_VERSION is required');
    expect(dockerfile).toContain('sha256sum -c');
    expect(dockerfile).toContain('linux/amd64 only');
  });

  it('bakes the binary path and keeps the fetch tools out of the final image', () => {
    expect(dockerfile).toContain('ENV CLOAKBROWSER_BINARY_PATH=/opt/cloakbrowser/cloakbrowser');
    expect(dockerfile).toContain('COPY --from=fetch-cloak /opt/cloakbrowser /opt/cloakbrowser');
  });

  it('installs Windows-metric, emoji and CJK fonts', () => {
    for (const pkg of [
      'fonts-liberation2',
      'fonts-crosextra-carlito',
      'fonts-noto-color-emoji',
      'fonts-noto-cjk',
    ]) {
      expect(dockerfile).toContain(pkg);
    }
  });

  it('copies every module the supervisor imports', () => {
    expect(dockerfile).toContain('COPY supervisor.mjs /opt/supervisor/supervisor.mjs');
    expect(dockerfile).toContain('COPY lib/ /opt/supervisor/lib/');
    const supervisor = readFileSync(join(dir, 'supervisor.mjs'), 'utf8');
    const local = [...supervisor.matchAll(/from '\.\/(lib\/[^']+)'/g)].map((m) => m[1]);
    const libFiles = readdirSync(join(dir, 'lib')).map((f) => `lib/${f}`);
    for (const f of local) expect(libFiles).toContain(f);
  });

  it('runs as a non-root user under tini', () => {
    expect(dockerfile).toContain('USER browser');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
  });
});
