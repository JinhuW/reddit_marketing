#!/usr/bin/env node
// CloakBrowser fingerprint probe (plan §4 T13). Runs on a browser node (Node 22.18+, Docker), never in CI.
//
//   Full run, the T13 "Done when" (seed A twice across a restart, seed B once, license host blocked):
//     CLOAKBROWSER_LICENSE_KEY=… node scripts/browser-probe.ts --image tl.invalid/browser-profile:<build>
//   One reading from a CDP endpoint that is already up:
//     node scripts/browser-probe.ts --cdp http://127.0.0.1:9222
//
// Options: --seed-a 1001 --seed-b 1002 --persona windows|macos|linux --gpu nvidia|intel|amd --tz UTC
//          --locale en-US --screen 1512x982 --ip-url <url> | --offline
//          --license-block network|hosts|skip (default network) --license-host <host> (repeatable, for hosts)
//          --ready-timeout 60 --keep --json
//          --docker-opt <opt> (repeatable, e.g. --docker-opt=--security-opt=seccomp=chrome.json) --no-sandbox
// Proxy: PROBE_PROXY_URL=http://user:pass@host:port in the env (never argv). The container gets scheme://host:port;
// the probe answers the proxy challenge over CDP Fetch.authRequired, as the node agent does.
// Exit code: 0 when every check passes or is skipped, 1 when one fails, 2 on a usage error.
import { parseArgs } from 'node:util';
import type { ProxyAuth } from '../apps/browser-profile/probe/cdp.ts';
import { CdpClient } from '../apps/browser-profile/probe/cdp.ts';
import {
  type ProfileRun,
  cdpUrl,
  docker,
  logsTail,
  remove,
  startProfile,
  waitForCdp,
  waitForExit,
} from '../apps/browser-profile/probe/docker.ts';
import { type Reading, parseIp, readPage } from '../apps/browser-profile/probe/readings.ts';
import {
  type Persona,
  type ProbeRuns,
  evaluateRuns,
  formatChecks,
  verdict,
} from '../apps/browser-profile/probe/report.ts';

const { values } = parseArgs({
  options: {
    cdp: { type: 'string' },
    image: { type: 'string' },
    'seed-a': { type: 'string', default: '1001' },
    'seed-b': { type: 'string', default: '1002' },
    persona: { type: 'string', default: 'windows' },
    gpu: { type: 'string', default: 'nvidia' },
    tz: { type: 'string', default: 'UTC' },
    locale: { type: 'string', default: 'en-US' },
    screen: { type: 'string', default: '1512x982' },
    'ip-url': { type: 'string', default: 'https://api.ipify.org?format=json' },
    offline: { type: 'boolean', default: false },
    'license-block': { type: 'string', default: 'network' },
    'license-host': { type: 'string', multiple: true, default: [] },
    'ready-timeout': { type: 'string', default: '60' },
    'docker-opt': { type: 'string', multiple: true, default: [] },
    'no-sandbox': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const usage = (msg: string): never => {
  process.stderr.write(`browser-probe: ${msg}\n`);
  process.exit(2);
};

const persona = values.persona as Persona;
if (!['windows', 'macos', 'linux'].includes(persona)) usage('--persona must be windows, macos or linux');
if (!['nvidia', 'intel', 'amd'].includes(values.gpu)) usage('--gpu must be nvidia, intel or amd');
if (!['network', 'hosts', 'skip'].includes(values['license-block'])) {
  usage('--license-block must be network, hosts or skip');
}
if (values['license-block'] === 'hosts' && values['license-host'].length === 0) {
  usage('--license-block hosts needs at least one --license-host');
}
const ipUrl = values.offline ? null : values['ip-url'];
const readyMs = Number(values['ready-timeout']) * 1000;

let auth: ProxyAuth | undefined;
let proxyServer: string | undefined;
if (process.env.PROBE_PROXY_URL) {
  const u = new URL(process.env.PROBE_PROXY_URL);
  if (u.username)
    auth = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  proxyServer = `${u.protocol}//${u.hostname}:${u.port}`;
}

const log = (msg: string) => {
  if (!values.json) process.stderr.write(`${msg}\n`);
};

async function readFrom(url: string): Promise<Reading> {
  const client = await CdpClient.connect(url);
  try {
    return await readPage(client, { ipUrl, auth });
  } finally {
    client.close();
  }
}

async function hostIp(): Promise<string | null> {
  if (!ipUrl) return null;
  try {
    const res = await fetch(ipUrl, { signal: AbortSignal.timeout(10_000) });
    return parseIp(await res.text());
  } catch {
    return null;
  }
}

function emit(runs: ProbeRuns, extra: Record<string, unknown> = {}): never {
  const checks = evaluateRuns(runs);
  const result = verdict(checks);
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ verdict: result, checks, runs, ...extra }, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${formatChecks(checks)}\n\nverdict: ${result.toUpperCase()}\n`);
    process.stdout.write(`\nreadings:\n${JSON.stringify(runs, null, 2)}\n`);
  }
  process.exit(result === 'pass' ? 0 : 1);
}

async function single(url: string): Promise<never> {
  log(`reading ${url}`);
  const a1 = await readFrom(url);
  return emit({
    persona,
    a1,
    a2: null,
    b: null,
    hostIp: await hostIp(),
    proxied: Boolean(proxyServer),
    offline: !ipUrl,
  });
}

async function full(image: string): Promise<never> {
  const stamp = Date.now().toString(36);
  const base = (seed: string): Omit<ProfileRun, 'name' | 'volume'> => ({
    image,
    env: {
      CLOAK_SEED: seed,
      CLOAK_PERSONA: persona,
      CLOAK_GPU: values.gpu,
      TZ: values.tz,
      LOCALE: values.locale,
      SCREEN: values.screen,
      ...(proxyServer ? { PROXY_URL: proxyServer } : {}),
      ...(values['no-sandbox'] ? { BROWSER_SANDBOX: 'off' } : {}),
    },
    dockerOpts: values['docker-opt'],
    inheritEnv: process.env.CLOAKBROWSER_LICENSE_KEY ? ['CLOAKBROWSER_LICENSE_KEY'] : [],
    publishCdp: true,
  });
  const a = { ...base(values['seed-a']), name: `tl-probe-a-${stamp}`, volume: `tl-probe-a-${stamp}` };
  const b = { ...base(values['seed-b']), name: `tl-probe-b-${stamp}`, volume: `tl-probe-b-${stamp}` };
  const l = {
    ...base(values['seed-a']),
    name: `tl-probe-license-${stamp}`,
    volume: `tl-probe-license-${stamp}`,
    publishCdp: false,
    ...(values['license-block'] === 'network'
      ? { network: 'none' as const }
      : { addHosts: values['license-host'] }),
  };
  const cleanup = async () => {
    if (values.keep) return;
    for (const p of [a, b, l]) await remove(p.name, p.volume);
  };

  const runs: ProbeRuns = {
    persona,
    a1: null,
    a2: null,
    b: null,
    proxied: Boolean(proxyServer),
    offline: !ipUrl,
  };
  const digest = await docker(['image', 'inspect', '-f', '{{.Id}}', image]).catch(() => 'unknown');
  try {
    runs.hostIp = await hostIp();

    log(`seed ${values['seed-a']}: first launch`);
    await startProfile(a);
    let url = await cdpUrl(a.name);
    await waitForCdp(url, readyMs);
    runs.a1 = await readFrom(url);

    log(`seed ${values['seed-a']}: restart on the same volume`);
    await docker(['stop', '-t', '15', a.name]);
    await docker(['start', a.name]);
    url = await cdpUrl(a.name);
    await waitForCdp(url, readyMs);
    runs.a2 = await readFrom(url);

    log(`seed ${values['seed-b']}: fresh volume`);
    await startProfile(b);
    url = await cdpUrl(b.name);
    await waitForCdp(url, readyMs);
    runs.b = await readFrom(url);

    if (values['license-block'] !== 'skip') {
      log(`license host blocked (${values['license-block']}): expecting exit 78`);
      await startProfile(l);
      runs.licenseBlockedExit = await waitForExit(l.name, readyMs);
    }
  } catch (err) {
    log(`probe error: ${(err as Error).message}`);
    for (const p of [a, b, l]) {
      const tail = await logsTail(p.name);
      if (tail) log(`--- ${p.name} logs ---\n${tail}`);
    }
    await cleanup();
    runs.error = (err as Error).message;
    return emit(runs, { image, imageId: digest });
  }
  await cleanup();
  return emit(runs, { image, imageId: digest });
}

if (values.cdp) await single(values.cdp);
else if (values.image) await full(values.image);
else usage('pass --image <ref> (full run) or --cdp <url> (one reading)');
