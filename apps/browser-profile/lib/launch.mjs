// Pure launch logic for the profile container: env parsing, browser flags, exit-code mapping and redaction.
// No side effects here, so supervisor.mjs stays small and this file is unit-tested (test/launch.test.ts).
// Runs on the image's Debian Node (18+): plain ESM, no dependencies.

/** Exit codes the container itself uses. The node agent maps them (plan §4 T21). */
export const EXIT = Object.freeze({
  /** Bad or missing env from the agent (EX_USAGE). Not a license problem. */
  usage: 64,
  /** CloakBrowser refused to run: license denied, expired, out of seats or license host unreachable (EX_CONFIG). */
  licenseDenied: 78,
});

export const PERSONAS = /** @type {const} */ (['windows', 'macos', 'linux']);
export const GPUS = /** @type {const} */ (['nvidia', 'intel', 'amd']);
export const ENGINES = /** @type {const} */ (['cloak', 'chromium']);

/**
 * CloakBrowser flag names. `--fingerprint` is the seed; platform and GPU pick the persona.
 * Taken from the CloakBrowser pilot (launch args `--fingerprint=<seed>`, `--fingerprint-platform`,
 * `--fingerprint-gpu-vendor`); re-check them against the pinned build in the G2 spike.
 */
export const CLOAK_FLAGS = Object.freeze({
  seed: '--fingerprint',
  platform: '--fingerprint-platform',
  gpuVendor: '--fingerprint-gpu-vendor',
  // Plan 0004 phase 2, from the CloakBrowser README's flag table (checked 2026-11-12). Each is sent only when a
  // person set it on the profile; unset, the seed decides.
  cpu: '--fingerprint-hardware-concurrency',
  memory: '--fingerprint-device-memory',
  noise: '--fingerprint-noise',
  webrtcIp: '--fingerprint-webrtc-ip',
});
export const WEBRTC_MODES = /** @type {const} */ (['disable_udp', 'replace', 'real']);

/**
 * Exit codes of the CloakBrowser launcher that mean a license failure. The pilot's license module used 76–79;
 * override with CLOAK_LICENSE_EXIT_CODES once the spike records what the pinned build really returns.
 */
export const DEFAULT_LICENSE_EXIT_CODES = Object.freeze([76, 77, 78, 79]);

/** stderr lines that mean the license check failed, whatever the exit code. */
const LICENSE_FAILURE =
  /licen[cs]e[^\n]{0,80}?(denied|invalid|expired|revoked|rejected|fail|unreachable|exceeded|not\s+valid)|seat\s+limit|no\s+(free|available)\s+seats?/i;

/**
 * @typedef {object} LaunchConfig
 * @property {'cloak'|'chromium'} engine
 * @property {string} binary           browser executable
 * @property {number|null} seed         CloakBrowser fingerprint seed (null only for the chromium engine)
 * @property {'windows'|'macos'|'linux'} persona
 * @property {'nvidia'|'intel'|'amd'} gpu
 * @property {string} tz               IANA zone; applied through the TZ env of the browser process
 * @property {string} locale           BCP 47, e.g. en-US
 * @property {{ width: number, height: number }} screen
 * @property {string|null} proxyServer  scheme://host:port, credentials removed
 * @property {number|null} cpu          navigator.hardwareConcurrency; null = from the seed
 * @property {number|null} memoryGb     navigator.deviceMemory; null = from the seed
 * @property {boolean} noise            canvas / WebGL / audio noise; false only when FP_NOISE=off
 * @property {'disable_udp'|'replace'|'real'} webrtc  WebRTC behind the proxy
 * @property {string|null} webrtcIp     exit IP for `replace`; null = the engine resolves it (`auto`)
 * @property {string} display
 * @property {number} cdpPort           public CDP port (the front proxy listens here)
 * @property {number} cdpInternalPort   browser's own CDP port, bound to 127.0.0.1
 * @property {number} vncPort           websockify port
 * @property {string} userDataDir
 * @property {number[]} licenseExitCodes
 * @property {string[]} secrets         values to redact from forwarded output
 * @property {boolean} sandbox          Chromium sandbox; off only when the runtime cannot give it user namespaces
 */

/**
 * An optional whole number from the environment; blank = not set.
 * @param {string|undefined} v
 * @param {number} min
 * @param {number} max
 * @param {string} name
 * @returns {number|null}
 */
function optionalInt(v, min, max, name) {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be a whole number in ${min}..${max}`);
  return n;
}

/** @param {string|undefined} v */
const blank = (v) => v === undefined || v.trim() === '';

/**
 * @param {string|undefined} raw
 * @param {number} fallback
 * @param {string} name
 */
function port(raw, fallback, name) {
  if (blank(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError(`${name} must be a TCP port`);
  return n;
}

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * `en_US.UTF-8` → `en-US`; `en-US` stays.
 * @param {string} v
 */
export function posixToBcp47(v) {
  const base = v.split('.')[0]?.split('@')[0] ?? '';
  return base.replace('_', '-');
}

/**
 * Proxy URL for `--proxy-server`: scheme, host and port only. Credentials are answered over CDP
 * (`Fetch.authRequired`) by the node agent, so they never reach the command line or `ps`.
 * @param {string} raw
 * @returns {string}
 */
export function proxyServerFlag(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError('PROXY_URL is not a URL');
  }
  const scheme = u.protocol.replace(/:$/, '');
  if (!['http', 'https', 'socks5'].includes(scheme)) {
    throw new ConfigError('PROXY_URL scheme must be http, https or socks5');
  }
  if (!u.hostname || !u.port) throw new ConfigError('PROXY_URL needs a host and a port');
  return `${scheme}://${u.hostname}:${u.port}`;
}

/**
 * @param {string|undefined} raw
 * @returns {boolean}
 */
function sandbox(raw) {
  if (blank(raw) || raw === 'on') return true;
  if (raw === 'off') return false;
  throw new ConfigError('BROWSER_SANDBOX must be on or off');
}

/**
 * Validates the container env and returns everything the supervisor needs.
 * @param {Record<string, string|undefined>} env
 * @returns {LaunchConfig}
 */
export function parseEnv(env) {
  const engine = blank(env.ENGINE) ? 'cloak' : /** @type {string} */ (env.ENGINE);
  if (!ENGINES.includes(/** @type {any} */ (engine)))
    throw new ConfigError('ENGINE must be cloak or chromium');

  const binary =
    engine === 'cloak'
      ? env.CLOAKBROWSER_BINARY_PATH
      : blank(env.CHROMIUM_PATH)
        ? '/usr/bin/chromium'
        : env.CHROMIUM_PATH;
  if (blank(binary)) throw new ConfigError('CLOAKBROWSER_BINARY_PATH is not set');

  let seed = null;
  if (!blank(env.CLOAK_SEED)) {
    const n = Number(env.CLOAK_SEED);
    if (!Number.isInteger(n) || n < 0 || n > 2147483647) {
      throw new ConfigError('CLOAK_SEED must be an integer in 0..2147483647');
    }
    seed = n;
  } else if (engine === 'cloak') {
    // A random seed per launch would look like a new device on every start (ADR-0001), so refuse.
    throw new ConfigError('CLOAK_SEED is required');
  }

  const persona = blank(env.CLOAK_PERSONA) ? 'windows' : /** @type {string} */ (env.CLOAK_PERSONA);
  if (!PERSONAS.includes(/** @type {any} */ (persona))) {
    throw new ConfigError('CLOAK_PERSONA must be windows, macos or linux');
  }
  const gpu = blank(env.CLOAK_GPU) ? 'nvidia' : /** @type {string} */ (env.CLOAK_GPU);
  if (!GPUS.includes(/** @type {any} */ (gpu)))
    throw new ConfigError('CLOAK_GPU must be nvidia, intel or amd');

  const screenRaw = blank(env.SCREEN) ? '1512x982' : /** @type {string} */ (env.SCREEN);
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(screenRaw);
  if (!m) throw new ConfigError('SCREEN must look like 1512x982');
  const screen = { width: Number(m[1]), height: Number(m[2]) };

  const locale = !blank(env.LOCALE)
    ? /** @type {string} */ (env.LOCALE)
    : posixToBcp47(blank(env.LANG) ? 'en_US.UTF-8' : /** @type {string} */ (env.LANG));
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) throw new ConfigError('LOCALE must be BCP 47');

  const cpu = optionalInt(env.FP_CPU, 1, 64, 'FP_CPU');
  const memoryGb = optionalInt(env.FP_MEMORY_GB, 1, 64, 'FP_MEMORY_GB');
  const webrtc = blank(env.FP_WEBRTC) ? 'disable_udp' : /** @type {string} */ (env.FP_WEBRTC);
  if (!WEBRTC_MODES.includes(/** @type {any} */ (webrtc)))
    throw new ConfigError('FP_WEBRTC must be disable_udp, replace or real');
  const webrtcIp = blank(env.FP_WEBRTC_IP) ? null : /** @type {string} */ (env.FP_WEBRTC_IP).trim();
  // Goes on the command line: only an address may pass.
  if (webrtcIp !== null && !/^[0-9A-Fa-f.:]{3,45}$/.test(webrtcIp))
    throw new ConfigError('FP_WEBRTC_IP must be an IP address');

  const licenseExitCodes = blank(env.CLOAK_LICENSE_EXIT_CODES)
    ? [...DEFAULT_LICENSE_EXIT_CODES]
    : /** @type {string} */ (env.CLOAK_LICENSE_EXIT_CODES)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);

  const cdpPort = port(env.CDP_PORT, 9222, 'CDP_PORT');
  const cdpInternalPort = port(env.CDP_INTERNAL_PORT, 9223, 'CDP_INTERNAL_PORT');
  if (cdpPort === cdpInternalPort) throw new ConfigError('CDP_PORT and CDP_INTERNAL_PORT must differ');

  const secrets = [env.CLOAKBROWSER_LICENSE_KEY, env.PROXY_PASSWORD, env.PROXY_URL].filter(
    /** @returns {s is string} */ (s) => typeof s === 'string' && s.length >= 4,
  );
  if (!blank(env.PROXY_URL)) {
    try {
      const u = new URL(/** @type {string} */ (env.PROXY_URL));
      if (u.password) secrets.push(decodeURIComponent(u.password));
    } catch {
      // reported by proxyServerFlag below
    }
  }

  return {
    engine: /** @type {'cloak'|'chromium'} */ (engine),
    binary: /** @type {string} */ (binary),
    seed,
    persona: /** @type {'windows'|'macos'|'linux'} */ (persona),
    gpu: /** @type {'nvidia'|'intel'|'amd'} */ (gpu),
    tz: blank(env.TZ) ? 'UTC' : /** @type {string} */ (env.TZ),
    locale,
    screen,
    proxyServer: blank(env.PROXY_URL) ? null : proxyServerFlag(/** @type {string} */ (env.PROXY_URL)),
    cpu,
    memoryGb,
    noise: !(typeof env.FP_NOISE === 'string' && env.FP_NOISE.trim().toLowerCase() === 'off'),
    webrtc: /** @type {'disable_udp'|'replace'|'real'} */ (webrtc),
    webrtcIp,
    display: blank(env.DISPLAY) ? ':99' : /** @type {string} */ (env.DISPLAY),
    cdpPort,
    cdpInternalPort,
    vncPort: port(env.VNC_PORT, 6080, 'VNC_PORT'),
    userDataDir: blank(env.USER_DATA_DIR) ? '/data/browser' : /** @type {string} */ (env.USER_DATA_DIR),
    licenseExitCodes,
    sandbox: sandbox(env.BROWSER_SANDBOX),
    secrets,
  };
}

/**
 * Browser command line. Headed under Xvfb; no user agent, client hint or viewport override: the binary
 * presents its persona's own values. CDP binds to loopback; the front proxy publishes it on the network.
 * @param {LaunchConfig} c
 * @returns {string[]}
 */
export function browserArgs(c) {
  const args = [
    `--user-data-dir=${c.userDataDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${c.cdpInternalPort}`,
    `--window-size=${c.screen.width},${c.screen.height}`,
    '--window-position=0,0',
    `--lang=${c.locale}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--password-store=basic',
  ];
  // Off costs the sandbox and shows an "unsupported flag" infobar that shrinks the viewport; prefer a seccomp
  // profile that allows user namespaces (README).
  if (!c.sandbox) args.push('--no-sandbox');
  if (c.engine === 'cloak') {
    args.push(
      `${CLOAK_FLAGS.seed}=${c.seed}`,
      `${CLOAK_FLAGS.platform}=${c.persona}`,
      `${CLOAK_FLAGS.gpuVendor}=${c.gpu}`,
    );
    if (c.cpu !== null) args.push(`${CLOAK_FLAGS.cpu}=${c.cpu}`);
    if (c.memoryGb !== null) args.push(`${CLOAK_FLAGS.memory}=${c.memoryGb}`);
    if (!c.noise) args.push(`${CLOAK_FLAGS.noise}=false`);
  }
  if (c.proxyServer) {
    args.push(`--proxy-server=${c.proxyServer}`);
    if (c.webrtc === 'replace' && c.engine === 'cloak') {
      // The engine reports the proxy's exit IP in ICE candidates instead of the node's own.
      args.push(`${CLOAK_FLAGS.webrtcIp}=${c.webrtcIp ?? 'auto'}`);
    } else {
      // Keep WebRTC on the proxy path so the page cannot learn the node's home IP. `real` is never honoured
      // behind a proxy, and plain Chromium cannot replace the address, so both fall back to this.
      args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    }
  }
  args.push('about:blank');
  return args;
}

/**
 * Env for the browser process: TZ and LANG drive the time zone and the default locale.
 * The license key is passed through (the binary reads it); nothing else from the agent leaks in.
 * @param {LaunchConfig} c
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, string>}
 */
export function browserEnv(c, env) {
  /** @type {Record<string, string>} */
  const out = {
    HOME: env.HOME || '/home/browser',
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    DISPLAY: c.display,
    TZ: c.tz,
    LANG: `${c.locale.replace('-', '_')}.UTF-8`,
    LANGUAGE: c.locale.replace('-', '_'),
  };
  if (env.CLOAKBROWSER_LICENSE_KEY) out.CLOAKBROWSER_LICENSE_KEY = env.CLOAKBROWSER_LICENSE_KEY;
  if (env.FONTCONFIG_FILE) out.FONTCONFIG_FILE = env.FONTCONFIG_FILE;
  return out;
}

/** @param {string} line */
export function looksLikeLicenseFailure(line) {
  return LICENSE_FAILURE.test(line);
}

/**
 * Container exit code for a browser that stopped.
 * @param {{ code: number|null, signal: string|null, licenseSignalSeen: boolean, stopping: boolean }} r
 * @param {number[]} licenseExitCodes
 */
export function containerExitCode(r, licenseExitCodes) {
  if (r.stopping) return 0;
  if (r.licenseSignalSeen) return EXIT.licenseDenied;
  if (r.code !== null && licenseExitCodes.includes(r.code)) return EXIT.licenseDenied;
  if (r.code === EXIT.licenseDenied) return EXIT.licenseDenied;
  // Any other stop, including a clean exit, ends the container: the agent decides whether to relaunch.
  if (r.code === null || r.code === 0) return 1;
  return r.code;
}

/**
 * The profile volume remembers the fingerprint it was first launched with. A different seed, persona or GPU on
 * the same volume would turn one account into a new device, so the supervisor refuses it.
 * @param {{ seed: number|null, persona: string, gpu: string } | null} stored  contents of the lock file, if any
 * @param {LaunchConfig} c
 * @returns {{ ok: true, write: boolean } | { ok: false, reason: string }}
 */
export function checkFingerprintLock(stored, c) {
  if (c.engine !== 'cloak') return { ok: true, write: false };
  if (!stored) return { ok: true, write: true };
  for (const key of /** @type {const} */ (['seed', 'persona', 'gpu'])) {
    if (stored[key] !== c[key]) {
      return { ok: false, reason: `${key} differs from the one this profile volume was created with` };
    }
  }
  return { ok: true, write: false };
}

/** Chromium's profile-in-use markers. `SingletonLock` is a symlink to `<hostname>-<pid>`. */
export const SINGLETON_FILES = Object.freeze(['SingletonLock', 'SingletonSocket', 'SingletonCookie']);

/**
 * Paths of the profile-in-use markers a browser that died uncleanly (OOM kill, `docker kill`, the SIGKILL
 * fallback) leaves on the persistent volume. They name the old container's hostname or a PID that a fresh
 * container can reuse, so Chromium would refuse the profile. One container owns one volume, so the supervisor
 * deletes them before every launch. `SingletonLock` is usually a dangling symlink: remove it without `existsSync`.
 * @param {string} userDataDir
 * @returns {string[]}
 */
export function staleSingletonFiles(userDataDir) {
  const dir = userDataDir.replace(/\/+$/, '') || '/';
  return SINGLETON_FILES.map((f) => (dir === '/' ? `/${f}` : `${dir}/${f}`));
}

/**
 * Replaces every secret value in a line of child output.
 * @param {string} line
 * @param {string[]} secrets
 */
export function redact(line, secrets) {
  let out = line;
  for (const s of secrets) {
    if (s) out = out.split(s).join('[redacted]');
  }
  return out;
}
