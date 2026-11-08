// Tests for deploy/node (plan T32). No network, no real Docker daemon:
//   node --test deploy/node/test/
// Needs bash 4+ for the script tests and the docker compose CLI for the compose test; each part skips itself
// (with the reason) when its tool is missing. shellcheck runs when it is on PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nodeDir = join(here, '..');
const repo = join(nodeDir, '..', '..');
const fakeBin = join(here, 'fake-bin');
const scripts = ['install.sh', 'backup.sh', 'lib.sh'].map((f) => join(nodeDir, f));
const SECRET = 'tok-0123456789abcdef-SECRET';
const LICENSE = 'cb_test_license_value_ABCDEF';

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const has = (cmd, args) => run(cmd, args).status === 0;
const bashMajor = Number(run('bash', ['-c', 'echo "${BASH_VERSINFO[0]}"']).stdout.trim() || 0);
const noBash = bashMajor >= 4 ? false : `bash 4+ required (found ${bashMajor || 'none'})`;

const tmpDirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tl-node-test-'));
  tmpDirs.push(d);
  return d;
};
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Run a snippet with lib.sh sourced. */
const lib = (snippet, input) =>
  run('bash', ['-c', `set -euo pipefail; . "$1"; ${snippet}`, 'lib', join(nodeDir, 'lib.sh')], { input });

describe('shell scripts', () => {
  for (const f of [...scripts, join(fakeBin, 'docker'), join(fakeBin, 'uname')]) {
    test(`bash -n ${f.slice(nodeDir.length + 1)}`, () => {
      const r = run('bash', ['-n', f]);
      assert.equal(r.status, 0, r.stderr);
    });
  }

  test('scripts are executable and strict', () => {
    for (const f of scripts.filter((s) => !s.endsWith('lib.sh'))) {
      assert.ok(statSync(f).mode & 0o100, `${f} is not executable`);
      assert.match(readFileSync(f, 'utf8'), /^set -euo pipefail$/m);
    }
  });

  test('shellcheck', { skip: has('shellcheck', ['--version']) ? false : 'shellcheck not on PATH' }, () => {
    const r = run('shellcheck', [
      '-x',
      '-P',
      nodeDir,
      ...scripts,
      join(fakeBin, 'docker'),
      join(fakeBin, 'uname'),
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('lib.sh', { skip: noBash }, () => {
  test('env_get reads Docker env-file syntax without expanding', () => {
    const f = join(tmp(), 'env');
    writeFileSync(
      f,
      [
        '# comment',
        '',
        'A=plain',
        'export B=exported',
        'C="double quoted"',
        "D='single'",
        'E=$HOME',
        'F=x=y',
        'G=first',
        'G=last',
        'H=',
        'I=crlf\r',
        '  J = spaced',
        'K',
      ].join('\n'),
    );
    const get = (k) => lib(`env_get ${k} "${f}"`);
    for (const [k, v] of [
      ['A', 'plain'],
      ['B', 'exported'],
      ['C', 'double quoted'],
      ['D', 'single'],
      ['E', '$HOME'],
      ['F', 'x=y'],
      ['G', 'last'],
      ['H', ''],
      ['I', 'crlf'],
    ]) {
      const r = get(k);
      assert.equal(r.status, 0, `${k}: ${r.stderr}`);
      assert.equal(r.stdout, v, k);
    }
    assert.equal(get('MISSING').status, 1);
    assert.equal(get('K').status, 1);
    assert.equal(lib(`env_value MISSING "${f}"`).status, 0);
    assert.equal(lib(`env_keys "${f}" | sort -u | tr '\\n' ' '`).stdout, 'A B C D E F G H I ');
  });

  test('select_profile_volumes keeps only tl-profile-*', () => {
    const r = lib(
      'select_profile_volumes',
      [
        'tl-profile-abc123',
        'rs-fleet-data',
        'tl-profile-',
        'opensearch_data',
        'tl-profile-x_y.z-1',
        'xtl-profile-a',
      ].join('\n'),
    );
    assert.equal(r.stdout, 'tl-profile-abc123\ntl-profile-x_y.z-1\n');
  });

  test('validators', () => {
    const ok = (s) => lib(s).status === 0;
    assert.ok(ok('valid_node_name browser-1'));
    assert.ok(!ok('valid_node_name Browser_1'));
    assert.ok(ok('gateway_url_ok wss://tl-gw-production.up.railway.app/agent'));
    assert.ok(ok('gateway_url_ok wss://nodes.example.com'));
    assert.ok(!ok('gateway_url_ok https://nodes.example.com'));
    assert.ok(ok('valid_cloak_version 145.0.7632.159.2'));
    assert.ok(!ok('valid_cloak_version "../x"'));
    assert.ok(ok('is_placeholder change-me') && ok('is_placeholder ""') && !ok('is_placeholder real'));
    assert.equal(lib('browser_image_tag cloak 1.2.3').stdout, 'tl.invalid/browser-profile:1.2.3');
    assert.equal(lib('browser_image_tag chromium 1.2.3').stdout, 'tl.invalid/browser-profile:chromium');
    // Local builds must sit under a registry host that never resolves, so a missing image is never pulled
    // from docker.io/threadline/* (a namespace we do not own).
    assert.match(lib('browser_image_tag cloak 1.2.3').stdout, /^tl\.invalid\//);
  });

  test('agent_log_state reads the agent log lines', () => {
    const state = (lines) => lib('agent_log_state', lines.join('\n')).stdout;
    assert.equal(state(['{"msg":"starting"}']), 'waiting');
    assert.equal(state(['{"msg":"starting"}', '{"msg":"connected to gateway"}']), 'connected');
    assert.match(state(['{"msg":"gateway rejected the node token (4401)"}']), /^fatal:.*4401/);
    assert.match(
      state(['invalid node agent environment: NODE_TOKEN: Required']),
      /^fatal:invalid environment/,
    );
  });
});

describe(
  'compose.yml',
  { skip: has('docker', ['compose', 'version']) ? false : 'docker compose not found' },
  () => {
    const config = (extraEnv = {}) => {
      const d = tmp();
      const envFile = join(d, 'node.env');
      writeFileSync(
        envFile,
        `GATEWAY_URL=wss://gw.example/agent\nNODE_NAME=browser-1\nNODE_TOKEN=${SECRET}\n`,
      );
      return run('docker', ['compose', '-f', join(nodeDir, 'compose.yml'), 'config', '--format', 'json'], {
        env: {
          ...process.env,
          TL_NODE_ENV: envFile,
          TL_REPO_DIR: repo,
          TL_SECCOMP_FILE: join(nodeDir, 'seccomp-browser.json'),
          TL_DOCKER_GID: '988',
          TL_AGENT_IMAGE: 'tl.invalid/node-agent:test',
          TL_BROWSER_IMAGE: 'tl.invalid/browser-profile:test',
          ...extraEnv,
        },
      });
    };

    test('a further instance gets its own project and container name', () => {
      const r = config({
        TL_PROJECT: 'threadline-node-browser-2',
        TL_AGENT_CONTAINER: 'tl-node-agent-browser-2',
      });
      assert.equal(r.status, 0, r.stderr);
      const c = JSON.parse(r.stdout);
      assert.equal(c.name, 'threadline-node-browser-2');
      assert.equal(c.services.agent.container_name, 'tl-node-agent-browser-2');
      assert.deepEqual(Object.keys(c.networks), ['tl-browsers'], 'instances share the browser network');
    });

    test('agent service: socket, network, restart, no ports, namespaced', () => {
      const r = config();
      assert.equal(r.status, 0, r.stderr);
      const c = JSON.parse(r.stdout);
      assert.equal(c.name, 'threadline-node');
      assert.deepEqual(Object.keys(c.services), ['agent']);
      const a = c.services.agent;
      assert.equal(a.container_name, 'tl-node-agent');
      assert.equal(a.restart, 'unless-stopped');
      assert.equal(a.image, 'tl.invalid/node-agent:test');
      assert.equal(a.pull_policy, 'missing');
      assert.equal(a.build.dockerfile, 'apps/node-agent/Dockerfile');
      assert.equal(a.ports, undefined, 'the agent publishes no ports');
      assert.equal(a.network_mode, undefined);
      assert.equal(a.privileged, undefined);
      assert.deepEqual(Object.keys(a.networks), ['tl-browsers']);
      assert.equal(c.networks['tl-browsers'].name, 'tl-browsers');
      assert.equal(c.networks['tl-browsers'].external, true);
      assert.deepEqual(Object.keys(c.networks), ['tl-browsers'], 'no project network is created');
      const sock = a.volumes.find((v) => v.target === '/var/run/docker.sock');
      assert.equal(sock?.source, '/var/run/docker.sock');
      assert.equal(sock?.type, 'bind');
      assert.ok(a.volumes.some((v) => v.target === '/etc/threadline/seccomp-browser.json' && v.read_only));
      assert.deepEqual(a.group_add.map(String), ['988']);
      assert.equal(a.environment.BROWSER_NETWORK, 'tl-browsers');
      assert.equal(a.environment.BROWSER_IMAGE, 'tl.invalid/browser-profile:test');
      assert.equal(a.environment.BROWSER_SECCOMP_PROFILE, '/etc/threadline/seccomp-browser.json');
      assert.equal(a.environment.NODE_NAME, 'browser-1', 'env_file is loaded');
      assert.equal(a.logging.driver, 'json-file');
      assert.ok(a.logging.options['max-size'] && a.logging.options['max-file']);
      assert.ok(a.read_only);
      assert.deepEqual(a.cap_drop, ['ALL']);
    });

    test('the default agent image is an unpullable local tag', () => {
      const r = config({ TL_AGENT_IMAGE: '' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).services.agent.image, 'tl.invalid/node-agent:local');
    });

    test('refuses to render without the values install.sh generates', () => {
      const r = config({ TL_BROWSER_IMAGE: '' });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /TL_BROWSER_IMAGE/);
    });
  },
);

describe('templates', () => {
  const example = readFileSync(join(nodeDir, 'node.env.example'), 'utf8');

  test('node.env.example names every variable the agent reads', () => {
    const src = ['apps/node-agent/src/config.ts', 'apps/node-agent/src/handlers/profile.ts']
      .map((f) => readFileSync(join(repo, f), 'utf8'))
      .join('\n');
    const keys = new Set([...src.matchAll(/^\s+([A-Z][A-Z0-9_]+): [A-Za-z]/gm)].map((m) => m[1]));
    assert.ok(keys.has('GATEWAY_URL') && keys.has('NODE_SEAT_LIMIT'), 'parsed the agent env schemas');
    // Set by compose.yml (environment:) so they cannot drift; AGENT_VERSION is for CI-built images.
    const fromCompose = new Set([
      'BROWSER_IMAGE',
      'BROWSER_NETWORK',
      'BROWSER_SECCOMP_PROFILE',
      'AGENT_VERSION',
    ]);
    for (const k of keys) {
      if (fromCompose.has(k) && k !== 'BROWSER_IMAGE') continue;
      assert.match(example, new RegExp(`^#?${k}=`, 'm'), `${k} missing from node.env.example`);
    }
  });

  test('node.env.example holds placeholders only, and no empty assignments', () => {
    for (const line of example.split('\n')) {
      if (!/^[A-Z_]+=/.test(line)) continue;
      const [k, v] = [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)];
      assert.notEqual(v, '', `${k} is empty`);
      if (/TOKEN|KEY|PASSWORD|SECRET/.test(k)) assert.equal(v, 'change-me', `${k} must be a placeholder`);
    }
    assert.doesNotMatch(example, /cb_[0-9a-f]{16,}/, 'no CloakBrowser key');
  });

  test("seccomp profile is Docker's default allowlist plus the namespace syscalls Chromium needs", () => {
    const p = JSON.parse(readFileSync(join(nodeDir, 'seccomp-browser.json'), 'utf8'));
    assert.equal(p.defaultAction, 'SCMP_ACT_ERRNO', 'unknown syscalls must be denied');
    // Allowed for every caller: no capability includes, no argument filters.
    const open = new Set(
      p.syscalls
        .filter(
          (r) => r.action === 'SCMP_ACT_ALLOW' && !r.args?.length && !Object.keys(r.includes ?? {}).length,
        )
        .flatMap((r) => r.names),
    );
    for (const s of ['clone', 'clone3', 'unshare', 'setns']) assert.ok(open.has(s), `${s} must be allowed`);
    for (const s of ['mount', 'keyctl', 'bpf', 'kexec_load', 'init_module', 'pivot_root'])
      assert.ok(!open.has(s), `${s} must not be open to every caller`);
    assert.ok(p.archMap.some((m) => m.architecture === 'SCMP_ARCH_X86_64'));
  });

  test('systemd timer is weekly and persistent', () => {
    const t = readFileSync(join(nodeDir, 'systemd', 'threadline-node-backup.timer'), 'utf8');
    assert.match(t, /^OnCalendar=Sun /m);
    assert.match(t, /^Persistent=true$/m);
    const s = readFileSync(join(nodeDir, 'systemd', 'threadline-node-backup.service'), 'utf8');
    assert.match(s, /^ExecStart=@PREFIX@\/bin\/backup\.sh$/m);
  });
});

describe('install.sh with a fake docker', { skip: noBash }, () => {
  /** A prefix, a fake socket and fake docker/uname on PATH. */
  const setup = async () => {
    const d = tmp();
    const state = join(d, 'state');
    const prefix = join(d, 'opt');
    run('mkdir', ['-p', state]);
    const sock = join(d, 'docker.sock');
    const server = createServer();
    await new Promise((res) => server.listen(sock, res));
    after(() => server.close());
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_STATE: state,
      TL_DOCKER_SOCK: sock,
    };
    const install = (args = [], extra = {}) =>
      run(join(nodeDir, 'install.sh'), ['--prefix', prefix, '--skip-timer', '--wait', '5', ...args], {
        env: { ...env, ...extra },
      });
    const calls = () => readFileSync(join(state, 'calls'), 'utf8');
    return { d, prefix, state, env, install, calls };
  };

  const fill = (prefix, extra = '') => {
    const f = join(prefix, 'node.env');
    writeFileSync(
      f,
      `GATEWAY_URL=wss://tl-gw.up.railway.app/agent\nNODE_NAME=browser-1\nNODE_TOKEN=${SECRET}\nCLOAKBROWSER_LICENSE_KEY=${LICENSE}\n${extra}`,
    );
    chmodSync(f, 0o644);
    return f;
  };

  test('refuses a non-x86_64 host', async () => {
    const { install } = await setup();
    const r = install([], { FAKE_ARCH: 'aarch64' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /x86_64 only/);
  });

  test('first run creates node.env (mode 600) from the template and stops', async () => {
    const { install, prefix } = await setup();
    const r = install();
    assert.equal(r.status, 2, r.stderr);
    const f = join(prefix, 'node.env');
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(readFileSync(f, 'utf8'), readFileSync(join(nodeDir, 'node.env.example'), 'utf8'));
    // Second run with the untouched template: refuses the placeholders.
    const r2 = install();
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /GATEWAY_URL is not set/);
  });

  test('rejects an empty optional variable the agent would reject', async () => {
    const { install, prefix } = await setup();
    run('mkdir', ['-p', prefix]);
    fill(prefix, 'NODE_SEAT_LIMIT=\n');
    const r = install(['--engine', 'chromium']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NODE_SEAT_LIMIT is empty/);
  });

  test('full run: builds, starts, waits for the connection, never prints secrets; idempotent', async () => {
    const { install, prefix, calls, state } = await setup();
    run('mkdir', ['-p', prefix]);
    const envFile = fill(prefix, 'CLOAK_VERSION=145.0.1\nCLOAK_URL=https://dl.example/{version}/cb.tar.gz\n');
    const r = install(['--rebuild-browser']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = r.stdout + r.stderr + calls();
    assert.ok(!out.includes(SECRET) && !out.includes(LICENSE), 'a secret reached output or docker argv');
    assert.equal(statSync(envFile).mode & 0o777, 0o600, 'node.env tightened to 600');
    assert.match(calls(), /^network create .*tl-browsers$/m);
    assert.match(calls(), /^compose -f .*compose\.yml build --quiet agent$/m);
    assert.match(
      calls(),
      /^build .*--build-arg CLOAK_VERSION=145\.0\.1 .*--secret id=cloak_key,env=CLOAKBROWSER_LICENSE_KEY/m,
    );
    assert.match(calls(), /^build-secret-env$/m);
    assert.match(calls(), /^run --rm --name tl-userns-check --network none --security-opt seccomp=/m);
    assert.match(
      calls(),
      /^compose -f .*\/opt\/compose\.yml --env-file .*\/opt\/compose\.env up -d --no-build --remove-orphans agent$/m,
    );
    assert.match(r.stdout, /tl-node-agent is connected/);
    const composeEnv = readFileSync(join(prefix, 'compose.env'), 'utf8');
    assert.match(composeEnv, /^TL_BROWSER_IMAGE=tl\.invalid\/browser-profile:145\.0\.1$/m);
    assert.match(composeEnv, /^TL_DOCKER_GID=\d+$/m);
    assert.ok(!composeEnv.includes(SECRET) && !composeEnv.includes(LICENSE));
    for (const f of ['compose.yml', 'seccomp-browser.json', 'bin/backup.sh', 'bin/lib.sh'])
      assert.ok(statSync(join(prefix, f)).isFile(), f);
    // Nothing outside the namespace: no stop/rm of other containers, no published ports.
    assert.doesNotMatch(calls(), /^(stop|rm|kill|network rm|volume rm|system prune)/m);
    assert.doesNotMatch(calls(), /(^| )(-p|--publish) /m);

    // Second run: the network and the browser image exist, so neither is created again.
    writeFileSync(join(state, 'calls'), '');
    const r2 = install();
    assert.equal(r2.status, 0, r2.stderr);
    assert.doesNotMatch(calls(), /^network create/m);
    assert.doesNotMatch(calls(), /^build /m);
    assert.match(r2.stdout, /exists \(pass --rebuild-browser to rebuild\)/);
  });

  test('--instance namespaces the agent so a second node can share the host', async () => {
    const { install, prefix, calls } = await setup();
    run('mkdir', ['-p', prefix]);
    fill(prefix, 'NODE_INSTANCE=browser-2\n');
    const r = install(['--engine', 'chromium']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const composeEnv = readFileSync(join(prefix, 'compose.env'), 'utf8');
    assert.match(composeEnv, /^TL_PROJECT=threadline-node-browser-2$/m);
    assert.match(composeEnv, /^TL_AGENT_CONTAINER=tl-node-agent-browser-2$/m);
    assert.match(r.stdout, /tl-node-agent-browser-2 is connected/);
    assert.match(calls(), /^logs --since \S+ tl-node-agent-browser-2$/m);
    const bad = install(['--engine', 'chromium', '--instance', 'Bad_Name']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--instance/);
  });

  test("no instance keeps the first node's names", async () => {
    const { install, prefix } = await setup();
    run('mkdir', ['-p', prefix]);
    fill(prefix);
    assert.equal(install(['--engine', 'chromium']).status, 0);
    const composeEnv = readFileSync(join(prefix, 'compose.env'), 'utf8');
    assert.match(composeEnv, /^TL_PROJECT=threadline-node$/m);
    assert.match(composeEnv, /^TL_AGENT_CONTAINER=tl-node-agent$/m);
  });

  test('registry images are pulled, not built', async () => {
    const { install, prefix, calls } = await setup();
    run('mkdir', ['-p', prefix]);
    fill(
      prefix,
      'AGENT_IMAGE=ghcr.io/o/threadline-node-agent@sha256:aa\nBROWSER_IMAGE=ghcr.io/o/threadline-browser-profile@sha256:bb\n',
    );
    const r = install();
    assert.equal(r.status, 0, r.stderr);
    assert.match(calls(), /^pull --quiet ghcr\.io\/o\/threadline-node-agent@sha256:aa$/m);
    assert.match(calls(), /^pull --quiet ghcr\.io\/o\/threadline-browser-profile@sha256:bb$/m);
    assert.doesNotMatch(calls(), /^build |compose .* build /m);
  });

  test('fails fast with the reason when the gateway rejects the token', async () => {
    const { install, prefix } = await setup();
    run('mkdir', ['-p', prefix]);
    fill(prefix);
    const r = install(['--engine', 'chromium'], {
      FAKE_AGENT_LOG: '{"level":50,"msg":"gateway rejected the node token (4401)"}',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gateway rejected NODE_TOKEN \(4401\)/);
  });
});

describe('backup.sh', { skip: noBash }, () => {
  const backup = (envText, extra = {}) => {
    const d = tmp();
    const state = join(d, 'state');
    run('mkdir', ['-p', state]);
    const f = join(d, 'node.env');
    writeFileSync(f, envText);
    const r = run(join(nodeDir, 'backup.sh'), ['--env-file', f, ...(extra.args ?? [])], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_STATE: state, ...extra.env },
    });
    let calls = '';
    try {
      calls = readFileSync(join(state, 'calls'), 'utf8');
    } catch {}
    return { r, calls };
  };

  test('skips with a clear message when restic is not configured', () => {
    const { r, calls } = backup(`NODE_TOKEN=${SECRET}\n#RESTIC_REPOSITORY=s3:x\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /backup skipped: RESTIC_REPOSITORY and RESTIC_PASSWORD are not both set/);
    assert.equal(calls, '');
  });

  test('backs up only tl-profile-* volumes, read-only, without the node secrets', () => {
    const { r, calls } = backup(
      `NODE_TOKEN=${SECRET}\nCLOAKBROWSER_LICENSE_KEY=${LICENSE}\nRESTIC_REPOSITORY=s3:https://s3.example/b\nRESTIC_PASSWORD=pw-not-printed\nAWS_ACCESS_KEY_ID=AKIAEXAMPLE\n`,
      { env: { FAKE_VOLUMES: 'tl-profile-a rs-fleet-db tl-profile-b opensearch-data' } },
    );
    assert.equal(r.status, 0, r.stderr);
    const runs = calls.split('\n').filter((l) => l.startsWith('run '));
    assert.ok(runs.length >= 3, calls); // cat config, backup, forget
    for (const l of runs) {
      assert.match(l, /--mount type=volume,source=tl-profile-a,target=\/backup\/tl-profile-a,readonly/);
      assert.match(l, /--mount type=volume,source=tl-profile-b,target=\/backup\/tl-profile-b,readonly/);
      assert.doesNotMatch(l, /rs-fleet|opensearch/);
      assert.match(l, /-e RESTIC_PASSWORD -e RESTIC_REPOSITORY|-e AWS_ACCESS_KEY_ID/);
      assert.doesNotMatch(l, /NODE_TOKEN|CLOAKBROWSER/);
    }
    assert.match(calls, /backup --tag threadline --tag tl-profile --host browser-node \/backup$/m);
    assert.match(calls, /forget --tag tl-profile --host browser-node --keep-weekly 8 --prune$/m);
    const out = r.stdout + r.stderr + calls;
    for (const s of [SECRET, LICENSE, 'pw-not-printed', 'AKIAEXAMPLE'])
      assert.ok(!out.includes(s), 'secret leaked');
  });
});

test('fake-bin is the only place docker is faked', () => {
  assert.deepEqual(readdirSync(fakeBin).sort(), ['docker', 'uname']);
});
