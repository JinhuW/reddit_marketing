// Turns probe readings into the T13 "Done when" verdict. Pure, so it is unit-tested without a browser.
import type { Reading } from './readings.ts';

export type Persona = 'windows' | 'macos' | 'linux';

export interface ProbeRuns {
  persona: Persona;
  /** seed A, first launch */
  a1: Reading | null;
  /** seed A, after a container restart on the same volume */
  a2: Reading | null;
  /** seed B, fresh volume */
  b: Reading | null;
  /** container exit code with the license host blocked; undefined when that run was skipped */
  licenseBlockedExit?: number | null;
  /** IP the probe host sees, for the proxy comparison */
  hostIp?: string | null;
  /** whether a proxy was configured for the profile */
  proxied?: boolean;
  /** probe ran with --offline: no exit IP was read */
  offline?: boolean;
  /** set when the probe stopped early; the verdict is then a failure */
  error?: string;
}

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

/** Signals that identify a device; a seed must hold all of them across restarts. */
const STABLE_KEYS = [
  'userAgent',
  'canvasHash',
  'audioHash',
  'webgl',
  'clientHints',
  'platform',
  'screen',
] as const;
/** Signals a different seed is expected to change. */
const SEED_KEYS = ['canvasHash', 'audioHash', 'webgl'] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffKeys(a: Reading, b: Reading, keys: readonly (keyof Reading)[]): string[] {
  return keys.filter((k) => !same(a[k], b[k]));
}

const UA_TOKEN: Record<Persona, RegExp> = {
  windows: /Windows NT/,
  macos: /Macintosh; Intel Mac OS X/,
  linux: /X11; Linux/,
};
const HINT_PLATFORM: Record<Persona, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const NAV_PLATFORM: Record<Persona, RegExp> = { windows: /^Win/, macos: /^Mac/, linux: /^Linux/ };

function personaProblems(r: Reading, persona: Persona): string[] {
  const out: string[] = [];
  if (!UA_TOKEN[persona].test(r.userAgent)) out.push(`user agent is not ${persona}: ${r.userAgent}`);
  if (!NAV_PLATFORM[persona].test(r.platform)) out.push(`navigator.platform is ${r.platform}`);
  if (r.clientHints && r.clientHints.platform !== HINT_PLATFORM[persona]) {
    out.push(`client hint platform is ${r.clientHints.platform}`);
  }
  if (/HeadlessChrome/.test(r.userAgent)) out.push('user agent says HeadlessChrome');
  if (!r.webgl) out.push('WebGL is unavailable');
  if (r.secureContext && !r.clientHints) out.push('no client hints in a secure context');
  if (r.webgl?.renderer && /SwiftShader|llvmpipe/i.test(r.webgl.renderer)) {
    out.push(`WebGL renderer is a software one: ${r.webgl.renderer}`);
  }
  return out;
}

export function evaluateRuns(runs: ProbeRuns): Check[] {
  const all = [runs.a1, runs.a2, runs.b].filter((r): r is Reading => r !== null);
  const checks: Check[] = [];
  if (runs.error) checks.push({ id: 'probe', title: 'probe completed', status: 'fail', detail: runs.error });

  checks.push(
    all.length === 0
      ? { id: 'webdriver', title: 'navigator.webdriver is false', status: 'skip', detail: 'no readings' }
      : {
          id: 'webdriver',
          title: 'navigator.webdriver is false',
          status: all.every((r) => r.webdriver === false) ? 'pass' : 'fail',
          detail: all.map((r) => String(r.webdriver)).join(', '),
        },
  );

  if (all.length === 0) {
    checks.push({
      id: 'persona',
      title: 'UA, client hints and GPU match the persona',
      status: 'skip',
      detail: '',
    });
  } else {
    const problems = [...new Set(all.flatMap((r) => personaProblems(r, runs.persona)))];
    checks.push({
      id: 'persona',
      title: `UA, client hints and GPU match the ${runs.persona} persona`,
      status: problems.length ? 'fail' : 'pass',
      detail: problems.length ? problems.join('; ') : (all[0]?.userAgent ?? ''),
    });
  }

  if (runs.a1 && runs.a2) {
    const changed = diffKeys(runs.a1, runs.a2, STABLE_KEYS);
    checks.push({
      id: 'seed-stable',
      title: 'one seed gives the same fingerprint after a restart',
      status: changed.length ? 'fail' : 'pass',
      detail: changed.length ? `changed: ${changed.join(', ')}` : `canvas ${runs.a1.canvasHash}`,
    });
  } else {
    checks.push({
      id: 'seed-stable',
      title: 'one seed is stable across restarts',
      status: 'skip',
      detail: '',
    });
  }

  if (runs.a1 && runs.b) {
    const changed = diffKeys(runs.a1, runs.b, SEED_KEYS);
    checks.push({
      id: 'seed-distinct',
      title: 'two seeds give different fingerprints',
      status: changed.length ? 'pass' : 'fail',
      detail: changed.length ? `differs in: ${changed.join(', ')}` : 'canvas, audio and WebGL are identical',
    });
  } else {
    checks.push({ id: 'seed-distinct', title: 'two seeds differ', status: 'skip', detail: '' });
  }

  if (runs.offline) {
    checks.push({
      id: 'exit-ip',
      title: 'exit IP read from the page',
      status: 'skip',
      detail: 'offline run',
    });
  } else if (all.length) {
    const ips = [...new Set(all.map((r) => r.exitIp))];
    const missing = ips.includes(null);
    let status: CheckStatus = missing ? 'fail' : 'pass';
    let detail = `page exit IP ${ips.join(', ')}`;
    if (runs.proxied && runs.hostIp && ips.includes(runs.hostIp)) {
      status = 'fail';
      detail += `; equals the node's own IP ${runs.hostIp}, so the proxy is not in the path`;
    } else if (runs.hostIp) {
      detail += `; node IP ${runs.hostIp}`;
    }
    checks.push({ id: 'exit-ip', title: 'exit IP read from the page', status, detail });
  }

  if (runs.licenseBlockedExit === undefined) {
    checks.push({
      id: 'license-denied',
      title: 'exit 78 with the license host blocked',
      status: 'skip',
      detail: '',
    });
  } else {
    checks.push({
      id: 'license-denied',
      title: 'exit 78 with the license host blocked',
      status: runs.licenseBlockedExit === 78 ? 'pass' : 'fail',
      detail:
        runs.licenseBlockedExit === null
          ? 'container was still running at the deadline'
          : `container exited ${runs.licenseBlockedExit}`,
    });
  }
  return checks;
}

export function verdict(checks: Check[]): 'pass' | 'fail' {
  return checks.some((c) => c.status === 'fail') ? 'fail' : 'pass';
}

export function formatChecks(checks: Check[]): string {
  const mark: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', skip: 'skip' };
  return checks
    .map((c) => `${mark[c.status]}  ${c.title}${c.detail ? `\n      ${c.detail}` : ''}`)
    .join('\n');
}
