# Browser node (`deploy/node`)

Installs and updates a Threadline browser node: the node agent (`apps/node-agent`) in Docker, which dials the
gateway over WSS and starts one CloakBrowser container per profile (`apps/browser-profile`). Plan T32, ADR-0001.
Target: a fresh VM goes from `install.sh` to `online` in the gateway in under 10 minutes.

```
browser-1 (x86_64, Docker)                                     Railway
┌──────────────────────────────────────────────┐   WSS out   ┌──────────────────┐
│ tl-node-agent  ── /var/run/docker.sock ──┐   │ ──────────▶ │ node-gateway     │
│      │ network tl-browsers (bridge)      │   │             │ /agent           │
│      ├─ tl-profile-<id> (CDP 9222, VNC 6080, volume tl-profile-<id>)        │
│      └─ …  started by the agent, never by compose                           │
└──────────────────────────────────────────────┘             └──────────────────┘
```

| File | What it is |
|---|---|
| `install.sh` | Idempotent install/update from a repo checkout (`--help` lists options) |
| `compose.yml` | The agent service: socket mount, `group_add` of the socket's gid, network `tl-browsers`, `restart: unless-stopped`, no ports, log rotation |
| `node.env.example` | Every variable the agent, the browser image build and the backup read. Placeholders only |
| `seccomp-browser.json` | Seccomp profile the agent passes to every browser container (see Seccomp) |
| `backup.sh`, `systemd/` | Weekly restic backup of `tl-profile-*` volumes and its timer |
| `lib.sh` | Helpers shared by the scripts (env-file reader, filters); unit-tested |
| `test/` | `node --test deploy/node/test/node.test.mjs`: shell syntax, shellcheck, lib, compose, templates, install/backup against a fake `docker` |
| `../../.github/workflows/deploy-node.yml` | Manual deploy through a self-hosted runner labelled `browser-node` |

## Shared host rules

The VM may already run other containers. Everything here is namespaced and nothing else is touched:

- compose project `threadline-node`, one container `tl-node-agent`; browser containers and volumes are
  `tl-profile-<id>`; one network `tl-browsers`; throwaway checks are named `tl-userns-check`, `tl-backup-<pid>`.
- **No published ports.** The agent only dials out; browsers are reached by name on `tl-browsers`.
- No `docker system prune`, no `down -v`, no changes to the daemon config or host sysctls.
- Install dir `/opt/threadline-node`; systemd units `threadline-node-backup.{service,timer}`.

## Secrets

`NODE_TOKEN` and `CLOAKBROWSER_LICENSE_KEY` live only in `/opt/threadline-node/node.env` (mode 600, outside the
repo). `install.sh` reads values from it line by line (never `source`s it), never prints one, and passes the key to
the browser image build only as a BuildKit secret from the build command's environment; when the key is set it
then scans the built image for it with `.github/scripts/assert-no-secret-in-image.sh`. `compose.env`, which
`install.sh` generates next to it, holds image names, paths and the socket gid only.

Note that `docker compose … config` (without `--quiet`) and `docker inspect tl-node-agent` print the container's
environment, secrets included: do not paste their output anywhere.

## First install (browser-1)

Prerequisites (G3): Ubuntu 24.04 x86_64, Docker 29 with the compose plugin, outbound HTTPS, a checkout of this repo.

1. **Gateway side.** The node-gateway service has `NODE_TOKEN_BROWSER_1` and the database has the `browser-1`
   `BrowserNode` row (docs/RUNBOOK-railway.md §7). Until `nodes.<domain>` exists, the gateway URL is its
   Railway-generated host: `wss://<service>.up.railway.app/agent`.
2. **Checkout** (as the user that will deploy, e.g. the runner user):
   `git clone <repo> ~/threadline && cd ~/threadline`.
3. **Create the env file:** `sudo deploy/node/install.sh --owner "$USER"`. The first run copies the template to
   `/opt/threadline-node/node.env` (mode 600) and stops with exit code 2.
4. **Fill it in:** `sudoedit /opt/threadline-node/node.env` — `GATEWAY_URL`, `NODE_NAME=browser-1`, `NODE_TOKEN`
   (same value as `NODE_TOKEN_BROWSER_1`), `CLOAKBROWSER_LICENSE_KEY`, `NODE_SEAT_LIMIT`, and the CloakBrowser build
   (`CLOAK_VERSION` plus `CLOAK_ARCHIVE` or `CLOAK_URL`/`CLOAK_SHA256`), or `BROWSER_IMAGE` for a registry image.
   Optionally the restic variables. Put a local archive under `/opt/threadline-node/`.
5. **Install:** `sudo deploy/node/install.sh --owner "$USER"`. It checks the host, creates `tl-browsers`, builds
   `tl.invalid/node-agent:<sha>` and `tl.invalid/browser-profile:<CLOAK_VERSION>` (`.invalid` never resolves, so
   these local tags can never be pulled from a registry someone else controls), installs the seccomp profile,
   checks user namespaces, starts `tl-node-agent`, waits for its `connected to gateway` log line (fails fast on
   4401/4409/4426 or an invalid env), and enables the weekly backup timer.
6. **Check:** the Browsers page (or `nodes.listOnline`) shows `browser-1` online; then run the probe from
   apps/browser-profile/README.md against the built image.

Smoke test without a CloakBrowser build: `--engine chromium` builds the stock-Chromium image (no fingerprinting;
never for real accounts).

## A second node on the same host

One VM can run more than one node (e.g. `browser-2` next to `browser-1`). Each agent only adopts and reports the
`tl-profile-*` containers labelled with its own `NODE_NAME`, and all of them share the `tl-browsers` network. Give the
new node its own install dir and an instance name:

```sh
sudo deploy/node/install.sh --prefix /opt/threadline-node-browser-2 --instance browser-2 --owner "$USER"
# fill in node.env as above with NODE_NAME=browser-2, its own NODE_TOKEN, and NODE_INSTANCE=browser-2 so later
# runs keep the names; then run the same command again
```

That gives compose project `threadline-node-browser-2`, container `tl-node-agent-browser-2` and timer
`threadline-node-backup-browser-2`. CloakBrowser seats are counted per license, so the `NODE_SEAT_LIMIT` values of
all nodes on one license should add up to its seats. The backup still copies every `tl-profile-*` volume on the host;
enable it on one node only.

## Update

From the checkout: `git pull && deploy/node/install.sh` (no sudo needed once `--owner` was used and the user is in
the `docker` group), or run the **Deploy node** workflow. The browser image is rebuilt only when `CLOAK_VERSION`
changes or with `--rebuild-browser`: a new CloakBrowser build changes every profile's user agent, so roll it like a
release, one profile first (ADR-0001). Registry images instead of local builds: `--agent-image` / `--browser-image`
(or `AGENT_IMAGE` / `BROWSER_IMAGE` in node.env), pinned by the digest `images.yml` prints, after `docker login ghcr.io`.

Day to day:

```sh
alias tlc='docker compose -f /opt/threadline-node/compose.yml --env-file /opt/threadline-node/compose.env'
tlc ps; tlc logs -f agent; tlc restart agent
docker ps --filter label=dev.threadline.role=browser-profile   # running profiles
```

Stopping the agent does not stop running browser containers; the next agent adopts them. Remove the node with
`tlc down` (keeps the `tl-profile-*` volumes and the network).

## GitHub runner

Register a self-hosted runner on the node with the extra label `browser-node`
(Settings → Actions → Runners → New self-hosted runner; `./config.sh --labels browser-node`; `sudo ./svc.sh install`).
The runner user must be in the `docker` group and own `/opt/threadline-node` (`install.sh --owner <runner user>`).
The workflow passes no secrets; it checks out the ref, runs the tests above and `install.sh --skip-timer` for every
install dir in the repo variable `NODE_PREFIXES`. It runs on its own after CI passes on `main` (only when node files
changed since the commit in `~/.threadline-node-deployed-sha`), or by hand. Without sudo, run the runner as a user
service instead of `svc.sh`: `loginctl enable-linger $USER` and a `~/.config/systemd/user/gh-runner.service` whose
`ExecStart` is `~/actions-runner/run.sh` (that is how the homelab runner `homelab-browser-node` runs).
Membership of the `docker` group is root-equivalent on that VM: only trusted workflows may target `browser-node`.

## Seccomp

Chromium's sandbox needs unprivileged user namespaces, which Docker's default seccomp profile blocks
(apps/browser-profile/README.md "Sandbox"). `seccomp-browser.json` allows `clone`/`clone3`/`unshare` and denies the
kernel-surface calls Docker's default profile denies (mount family, module loading, kexec, keyctl, bpf,
perf_event_open, io_uring, setns, …). `install.sh` copies it to `/opt/threadline-node/seccomp-browser.json`; compose
mounts it into the agent and sets `BROWSER_SECCOMP_PROFILE`, and the agent passes it to every `tl-profile-*`.

`install.sh` then runs `unshare --user` in a throwaway browser container. If that fails on Ubuntu 24.04, AppArmor's
`kernel.apparmor_restrict_unprivileged_userns=1` is the usual cause. `install.sh` does not change host sysctls on a
shared VM; decide with the host owner (e.g. `/etc/sysctl.d/60-threadline-userns.conf` with the value `0`, or an
AppArmor profile that allows `userns`).

## Backups

`/opt/threadline-node/bin/backup.sh` (weekly via `threadline-node-backup.timer`, Sunday 03:30 ± 20 min) backs up
every `tl-profile-*` volume, read-only, with restic in a throwaway container, then
`restic forget --keep-weekly ${RESTIC_KEEP_WEEKLY:-8} --prune`. It reads `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`
and backend credentials from node.env and passes them by name only; without a repository and password it logs
`backup skipped: …` and exits 0. Running profiles are copied live (Chromium recovers like after a crash).

```sh
sudo systemctl start threadline-node-backup.service && journalctl -u threadline-node-backup -n 50
/opt/threadline-node/bin/backup.sh --dry-run           # lists what would be backed up
```

No systemd: `30 3 * * 0 root /opt/threadline-node/bin/backup.sh >>/var/log/threadline-node-backup.log 2>&1` in
`/etc/cron.d/threadline-node-backup`.

Restore one profile (its container stopped): `restic restore latest --tag tl-profile --include /backup/tl-profile-<id>
--target /restore` in the same restic image, then copy into the volume.

## Tests

```sh
node --test deploy/node/test/node.test.mjs
```

Needs bash 4+ (macOS's bash 3.2 skips the script tests) and the docker compose CLI (no daemon needed). shellcheck
runs when installed. `install.sh` and `backup.sh` run against `test/fake-bin/docker`, which records every call, so
the tests also assert that no secret reaches output or `docker` argv and that nothing outside the namespace is
touched.
