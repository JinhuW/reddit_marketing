// Container entrypoint (under tini): Xvfb, the CloakBrowser binary (headed, seeded fingerprint, CDP on loopback),
// the CDP front proxy on CDP_PORT, x11vnc and websockify on VNC_PORT. Any child stopping stops the container;
// a license failure exits 78 so the node agent maps it to `license_denied`. Env contract: README.md.
// Proxy auth is answered by the node agent over CDP `Fetch.authRequired`; credentials never reach argv.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createCdpFront } from './lib/cdp-front.mjs';
import {
  ConfigError,
  EXIT,
  browserArgs,
  browserEnv,
  checkFingerprintLock,
  containerExitCode,
  looksLikeLicenseFailure,
  parseEnv,
  redact,
  staleSingletonFiles,
} from './lib/launch.mjs';

/** @param {string} msg */
const log = (msg) => process.stderr.write(`[supervisor] ${msg}\n`);

/** @type {import('./lib/launch.mjs').LaunchConfig} */
let cfg;
try {
  cfg = parseEnv(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    log(`config error: ${err.message}`);
    process.exit(EXIT.usage);
  }
  throw err;
}

mkdirSync(cfg.userDataDir, { recursive: true });
const lockFile = join(dirname(cfg.userDataDir), '.fingerprint.json');
let stored = null;
if (existsSync(lockFile)) {
  try {
    stored = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    log(`unreadable ${lockFile}; refusing to guess the fingerprint`);
    process.exit(EXIT.usage);
  }
}
const lock = checkFingerprintLock(stored, cfg);
if (!lock.ok) {
  log(`refusing to start: ${lock.reason}`);
  process.exit(EXIT.usage);
}
if (lock.write) {
  writeFileSync(lockFile, JSON.stringify({ seed: cfg.seed, persona: cfg.persona, gpu: cfg.gpu }), {
    mode: 0o600,
  });
}
// One container owns one volume: any Singleton* marker here belongs to a browser that is gone.
for (const file of staleSingletonFiles(cfg.userDataDir)) {
  try {
    rmSync(file, { force: true });
  } catch (err) {
    log(`could not remove ${file}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const children = new Map();
let stopping = false;
let licenseSignalSeen = false;

/** @param {number} code */
function shutdown(code) {
  stopping = true;
  for (const child of children.values()) child.kill('SIGTERM');
  const deadline = setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
    process.exit(code);
  }, 8000);
  deadline.unref();
  const wait = setInterval(() => {
    if ([...children.values()].every((c) => c.exitCode !== null || c.signalCode !== null)) {
      clearInterval(wait);
      process.exit(code);
    }
  }, 100);
}

/**
 * @param {string} name
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, scan?: boolean }} [opts]
 */
function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(name, child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      if (opts.scan && !licenseSignalSeen && looksLikeLicenseFailure(line)) {
        licenseSignalSeen = true;
        // A build that reports the failure but keeps running would still hold the agent's start for 30 s.
        setTimeout(() => {
          if (!stopping && child.exitCode === null) {
            log(`license check failed; container exits ${EXIT.licenseDenied}`);
            shutdown(EXIT.licenseDenied);
          }
        }, 5000).unref();
      }
      process.stderr.write(`[${name}] ${redact(line, cfg.secrets)}\n`);
    });
  }
  child.on('error', (err) => {
    log(`${name} failed to start: ${err.message}`);
    if (!stopping) shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    if (name === 'browser') {
      const exit = containerExitCode({ code, signal, licenseSignalSeen, stopping }, cfg.licenseExitCodes);
      log(
        exit === EXIT.licenseDenied
          ? `browser stopped: license check failed (exit ${code}); container exits ${EXIT.licenseDenied}`
          : `browser exited (code ${code}, signal ${signal}); stopping container`,
      );
      shutdown(exit);
    } else {
      log(`${name} exited (code ${code}, signal ${signal}); stopping container`);
      shutdown(code || 1);
    }
  });
  return child;
}

/**
 * @param {string} display
 * @param {number} ms
 */
async function waitForDisplay(display, ms) {
  const socket = `/tmp/.X11-unix/X${display.replace(/^:/, '').split('.')[0]}`;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(socket)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

const { width, height } = cfg.screen;
run('xvfb', 'Xvfb', [cfg.display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-ac']);
if (!(await waitForDisplay(cfg.display, 10_000))) {
  log('Xvfb did not come up in 10 s');
  shutdown(1);
} else {
  const args = browserArgs(cfg);
  log(
    `starting ${cfg.engine} (${cfg.binary}) seed=${cfg.seed ?? '-'} persona=${cfg.persona} gpu=${cfg.gpu} ` +
      `tz=${cfg.tz} locale=${cfg.locale} screen=${width}x${height} proxy=${cfg.proxyServer ? 'yes' : 'no'}`,
  );
  run('browser', cfg.binary, args, { env: browserEnv(cfg, process.env), scan: cfg.engine === 'cloak' });
  run('x11vnc', 'x11vnc', [
    '-display',
    cfg.display,
    '-forever',
    '-shared',
    '-nopw',
    '-localhost',
    '-rfbport',
    '5900',
    '-quiet',
  ]);
  run('websockify', 'websockify', ['--web', '/usr/share/novnc', String(cfg.vncPort), 'localhost:5900']);
  const front = createCdpFront({ listenPort: cfg.cdpPort, upstreamPort: cfg.cdpInternalPort });
  front.on('error', (err) => {
    log(`CDP front proxy failed: ${err.message}`);
    shutdown(1);
  });
}
