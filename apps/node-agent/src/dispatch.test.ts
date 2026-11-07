import { type AgentMessage, Cmd, type Command, type Result } from '@threadline/shared';
import { describe, expect, it } from 'vitest';
import { Dispatcher, guardMs } from './dispatch';
import { modules } from './handlers';
import { SecretSet, createLogger } from './log';
import { type HandlerMap, type HandlerResult, mergeHandlers } from './registry';
import { StatusStore } from './status';
import { sleep, testConfig } from './testing/helpers';

const comment = (draftId = 'd1'): Command['cmd'] => ({
  kind: 'action.submitComment',
  profileId: 'p1',
  draftId,
  threadUrl: 'https://www.reddit.com/r/test/comments/abc/x/',
  parentFullname: 't3_abc',
  body: 'hello',
});

function setup(handlers: HandlerMap, cacheSize?: number) {
  const secrets = new SecretSet();
  const config = testConfig();
  const status = new StatusStore(config.maxProfiles);
  const d = new Dispatcher({
    handlers,
    log: createLogger({ level: 'silent' }),
    secrets,
    config,
    status,
    cacheSize,
  });
  const sent: AgentMessage[] = [];
  const send = (m: AgentMessage) => {
    sent.push(m);
    return true;
  };
  const results = () => sent.filter((m): m is Result => m.type === 'result');
  return { d, sent, send, results, secrets, status };
}

const cmd = (cmdId: string, c: Command['cmd'], deadlineMs = 5_000): Command => ({
  type: 'command',
  cmdId,
  deadlineMs,
  cmd: c,
});

describe('Dispatcher', () => {
  it('acks first, then sends the handler result', async () => {
    const { d, sent, send } = setup({
      'action.submitComment': async () => ({ outcome: 'posted', data: { fullname: 't1_new' } }),
    });
    await d.handle(cmd('bj-1', comment()), send);
    expect(sent).toEqual([
      { type: 'ack', cmdId: 'bj-1' },
      { type: 'result', cmdId: 'bj-1', outcome: 'posted', data: { fullname: 't1_new' } },
    ]);
  });

  it('replays a stored result instead of re-running the command', async () => {
    let runs = 0;
    const { d, send, results } = setup({
      'action.submitComment': async () => {
        runs++;
        return { outcome: 'posted', data: { fullname: 't1_once' } };
      },
    });
    await d.handle(cmd('bj-2', comment()), send);
    await d.handle(cmd('bj-2', comment()), send);
    expect(runs).toBe(1);
    expect(results().map((r) => r.data)).toEqual([{ fullname: 't1_once' }, { fullname: 't1_once' }]);
  });

  it('a repeat of a running command waits for it rather than starting it twice', async () => {
    let runs = 0;
    const { d, send, results } = setup({
      'action.sendDm': async () => {
        runs++;
        await sleep(50);
        return { outcome: 'posted', data: { fullname: 't4_dm' } };
      },
    });
    const dm: Command['cmd'] = {
      kind: 'action.sendDm',
      profileId: 'p1',
      draftId: 'd2',
      to: 'u',
      subject: 's',
      body: 'b',
    };
    await Promise.all([d.handle(cmd('bj-3', dm), send), d.handle(cmd('bj-3', dm), send)]);
    expect(runs).toBe(1);
    expect(results()).toHaveLength(2);
    expect(results().every((r) => r.outcome === 'posted')).toBe(true);
  });

  it('reports deadline_exceeded before the deadline and later replays the real result', async () => {
    let aborted = false;
    let runs = 0;
    const { d, send, results } = setup({
      'action.submitComment': async (_c, ctx) => {
        runs++;
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await sleep(1_200);
        return { outcome: 'posted', data: { fullname: 't1_late' } };
      },
    });
    // Margins in hundreds of ms: this file runs next to Chromium-driven action tests (T22) on a busy CPU.
    const t0 = Date.now();
    await d.handle(cmd('bj-4', comment(), 1_000), send);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(results()[0]).toMatchObject({ outcome: 'error', error: { code: 'deadline_exceeded' } });
    expect(aborted).toBe(true);
    expect(d.cached('bj-4')).toBeUndefined();

    // A retry while the slow post is still running joins it; after that it is a replay.
    await d.handle(cmd('bj-4', comment(), 5_000), send);
    expect(results()[1]).toMatchObject({ outcome: 'posted', data: { fullname: 't1_late' } });
    await d.handle(cmd('bj-4', comment(), 5_000), send);
    expect(results()[2]).toMatchObject({ outcome: 'posted' });
    expect(runs).toBe(1);
  });

  it('caches errors from posting commands but lets other kinds retry', async () => {
    let starts = 0;
    let posts = 0;
    const { d, send } = setup({
      'profile.start': async () => {
        starts++;
        return { outcome: 'error', error: { code: 'docker', message: 'transient' } };
      },
      'action.submitComment': async () => {
        posts++;
        return { outcome: 'error', error: { code: 'unknown_state', message: 'page crashed after submit' } };
      },
    });
    const start: Command['cmd'] = {
      kind: 'profile.start',
      profileId: 'p1',
      seed: 1,
      persona: 'windows',
      gpu: 'nvidia',
      tz: 'UTC',
      locale: 'en-US',
      screen: '1920x1080',
      proxy: null,
    };
    await d.handle(cmd('bj-5', start), send);
    await d.handle(cmd('bj-5', start), send);
    await d.handle(cmd('bj-6', comment()), send);
    await d.handle(cmd('bj-6', comment()), send);
    expect(starts).toBe(2);
    expect(posts).toBe(1);
  });

  it('turns a thrown handler into an error result with secrets scrubbed', async () => {
    const { d, send, results } = setup({
      'profile.start': async (c) => {
        throw new Error(`proxy auth failed for ${c.proxy?.username}:${c.proxy?.password}`);
      },
    });
    await d.handle(
      cmd('bj-7', {
        kind: 'profile.start',
        profileId: 'p1',
        seed: 1,
        persona: 'windows',
        gpu: 'nvidia',
        tz: 'UTC',
        locale: 'en-US',
        screen: '1920x1080',
        proxy: { protocol: 'http', host: 'h', port: 1, username: 'user', password: 'proxy-secret-1' },
      }),
      send,
    );
    const r = results()[0]!;
    expect(r).toMatchObject({ outcome: 'error', error: { code: 'handler_error' } });
    expect(r.error?.message).not.toContain('proxy-secret-1');
    expect(r.error?.message).toContain('[Redacted]');
  });

  it('keeps only the most recent results', async () => {
    let runs = 0;
    const { d, send } = setup(
      {
        'action.submitComment': async (): Promise<HandlerResult> => {
          runs++;
          return { outcome: 'posted' };
        },
      },
      3,
    );
    for (const id of ['a', 'b', 'c', 'd']) await d.handle(cmd(id, comment()), send);
    expect(d.cached('a')).toBeUndefined();
    expect(d.cached('d')).toBeDefined();
    await d.handle(cmd('a', comment()), send);
    expect(runs).toBe(5);
  });

  it('the shipped stubs answer not_implemented and health reports status', async () => {
    const { d, send, results, status } = setup(mergeHandlers(modules));
    status.setProvider({ running: () => [{ profileId: 'p9', startedAt: 1 }], docker: async () => 'ok' });
    await d.handle(cmd('bj-8', comment()), send);
    await d.handle(
      cmd('bj-9', {
        kind: 'vnc.open',
        profileId: 'p',
        sessionId: 's',
        upstreamUrl: 'wss://x/vnc/s?t=tok12345',
        token: 'tok12345',
      }),
      send,
    );
    await d.handle(cmd('bj-10', { kind: 'health.check' }), send);
    const [a, b, h] = results();
    // action.* is real since T22: with no tl-profile-p container to dial it fails before touching any page.
    expect(a?.error?.code).toBe('cdp_unreachable');
    // vnc.open is real since T24: with no profile container it fails cleanly instead of answering not_implemented.
    expect(b).toMatchObject({ outcome: 'error', error: { code: 'vnc_target_unreachable' } });
    expect(h).toMatchObject({
      outcome: 'ok',
      data: { running: [{ profileId: 'p9', startedAt: 1 }], seats: { inUse: 0, limit: null }, docker: 'ok' },
    });
  });

  it('every command kind has exactly one handler', () => {
    const kinds = Object.keys(mergeHandlers(modules)).sort();
    expect(kinds).toEqual(Cmd.options.map((o) => o.shape.kind.value).sort());
  });

  it('guards a little before the deadline', () => {
    expect(guardMs(30_000)).toBe(29_500);
    expect(guardMs(1_000)).toBe(750);
  });
});
