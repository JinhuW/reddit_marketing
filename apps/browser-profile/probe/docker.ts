// Docker CLI helpers for the probe. The probe runs on the browser node itself (plan §4 T13), next to Docker, and
// publishes CDP on 127.0.0.1 only for the duration of the probe. Secrets go through `-e NAME` (value inherited
// from the probe's env), so they never appear in argv or `ps`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await exec('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export interface ProfileRun {
  name: string;
  volume: string;
  image: string;
  /** env passed by value: never secrets */
  env: Record<string, string>;
  /** env names passed by reference to the probe's own environment (secrets) */
  inheritEnv: string[];
  network?: 'none' | 'default';
  addHosts?: string[];
  publishCdp: boolean;
  /** extra `docker run` options, e.g. a seccomp profile */
  dockerOpts?: string[];
}

/** `docker run` argv for one profile container, shaped like the node agent's (plan §4 T21). */
export function runArgs(p: ProfileRun): string[] {
  const args = ['run', '-d', '--name', p.name, '-v', `${p.volume}:/data`, '--shm-size=1g', '--memory=1536m'];
  args.push('--label', 'threadline.probe=1');
  if (p.network === 'none') args.push('--network', 'none');
  for (const h of p.addHosts ?? []) args.push('--add-host', `${h}:127.0.0.1`);
  if (p.publishCdp && p.network !== 'none') args.push('-p', '127.0.0.1::9222');
  for (const [k, v] of Object.entries(p.env)) args.push('-e', `${k}=${v}`);
  for (const k of p.inheritEnv) args.push('-e', k);
  args.push(...(p.dockerOpts ?? []));
  args.push(p.image);
  return args;
}

export async function startProfile(p: ProfileRun): Promise<void> {
  await docker(runArgs(p));
}

export async function cdpUrl(name: string): Promise<string> {
  const out = await docker(['port', name, '9222/tcp']);
  const first = out.split('\n')[0] ?? '';
  const port = first.split(':').pop();
  if (!port) throw new Error(`no published CDP port on ${name}`);
  return `http://127.0.0.1:${port}`;
}

export async function waitForCdp(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const res = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`CDP at ${url} not ready after ${timeoutMs} ms (${last})`);
}

/** Exit code of a container, or null if it is still running at the deadline. */
export async function waitForExit(name: string, timeoutMs: number): Promise<number | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const state = await docker(['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', name]);
    const [running, code] = state.split(' ');
    if (running === 'false') return Number(code);
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

export async function logsTail(name: string, lines = 40): Promise<string> {
  try {
    const { stdout, stderr } = await exec('docker', ['logs', '--tail', String(lines), name]);
    return `${stdout}${stderr}`.trim();
  } catch {
    return '';
  }
}

export async function remove(name: string, volume?: string): Promise<void> {
  await docker(['rm', '-f', name]).catch(() => '');
  if (volume) await docker(['volume', 'rm', '-f', volume]).catch(() => '');
}
