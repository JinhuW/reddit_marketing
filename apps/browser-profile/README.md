# browser-profile

One container per `BrowserProfile`: a pinned CloakBrowser build, headed under Xvfb, with a seeded fingerprint.
The node agent (`apps/node-agent`, plan §4 T21) starts it on the node's internal Docker network as
`tl-profile-<id>`, attaches over CDP and pipes VNC. Nothing is published on the node host. ADR-0001 has the why.

```
tini ─ supervisor.mjs ─┬─ Xvfb :99
                       ├─ CloakBrowser --fingerprint=<seed> --fingerprint-platform=<persona>
                       │     --fingerprint-gpu-vendor=<gpu>  CDP on 127.0.0.1:9223
                       ├─ CDP front proxy 0.0.0.0:9222 → 127.0.0.1:9223 (Host rewrite, /json URL rewrite)
                       ├─ x11vnc 127.0.0.1:5900
                       └─ websockify 0.0.0.0:6080 → :5900 (noVNC)
```

## Env contract (set by the node agent from `profile.start`)

| Variable | Required | Meaning |
|---|---|---|
| `CLOAK_SEED` | yes (cloak) | `BrowserProfile.cloakSeed`, int 0..2³¹−1. Never random: a new seed is a new device |
| `CLOAK_PERSONA` | no, `windows` | `windows` \| `macos` \| `linux` (`CloakPersona`) |
| `CLOAK_GPU` | no, `nvidia` | `nvidia` \| `intel` \| `amd` (`CloakGpu`) |
| `TZ` | no, `UTC` | IANA zone from `profile.start.tz` |
| `LOCALE` | no, from `LANG` | BCP 47 from `profile.start.locale`; sets `--lang`, `LANG`, `LANGUAGE` |
| `SCREEN` | no, `1512x982` | `WxH`; Xvfb size and window size. No viewport emulation |
| `FP_CPU`, `FP_MEMORY_GB` | no | `--fingerprint-hardware-concurrency` / `--fingerprint-device-memory`; unset = from the seed |
| `FP_NOISE` | no, on | `off` adds `--fingerprint-noise=false` (canvas, WebGL, audio); the seed still fixes the device |
| `FP_WEBRTC` | no, `disable_udp` | behind a proxy: `disable_udp` keeps `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`; `replace` sends `--fingerprint-webrtc-ip=<FP_WEBRTC_IP or auto>` instead; `real` is never honoured behind a proxy |
| `FP_WEBRTC_IP` | no | the proxy's exit IP for `replace` (from the last connection test) |
| `PROXY_URL` | no | `http|https|socks5://host:port`. Credentials are stripped before `--proxy-server`; the agent answers the proxy challenge over CDP `Fetch.authRequired` |
| `CLOAKBROWSER_LICENSE_KEY` | yes (cloak) | passed to the binary only; redacted from all forwarded output |
| `CLOAK_LICENSE_EXIT_CODES` | no, `76,77,78,79` | launcher exit codes that mean a license failure |
| `BROWSER_SANDBOX` | no, `on` | `off` adds `--no-sandbox`; see Sandbox below |
| `CDP_PORT`, `CDP_INTERNAL_PORT`, `VNC_PORT` | no | 9222, 9223, 6080 |

The volume at `/data` holds the browser profile (`/data/browser`) and `/data/.fingerprint.json`, written on the first
launch. A later launch with a different seed, persona or GPU on the same volume is refused (exit 64).

## Sandbox

Chromium's sandbox needs unprivileged user namespaces, which Docker's default seccomp profile blocks: with it the
browser exits at start ("No usable sandbox"). Keep the sandbox and run the container with a seccomp profile that
allows `clone`/`unshare` with user namespaces (verified locally with `--security-opt seccomp=unconfined`; the node
agent should ship a narrower profile). `BROWSER_SANDBOX=off` is the fallback: it drops the sandbox and shows an
"unsupported command-line flag" infobar that shrinks the viewport, which is itself a tell.

## Exit codes

| Code | Meaning | Agent maps to |
|---|---|---|
| 0 | stopped by `docker stop` | — |
| 64 | bad env, or fingerprint differs from the volume's lock | `error` |
| 78 | license check failed: launcher exit code in `CLOAK_LICENSE_EXIT_CODES`, or a license-failure line on its output | `license_denied` |
| other | browser, Xvfb, x11vnc, websockify or the CDP proxy stopped | `error` (wait 60 s before relaunch) |

## Build

The image is `linux/amd64` only and needs one pinned CloakBrowser build. The key, if the download needs one, is a
BuildKit secret and never lands in a layer or in `docker history`.

```sh
CLOAKBROWSER_LICENSE_KEY=… docker buildx build --platform linux/amd64 \
  --secret id=cloak_key,env=CLOAKBROWSER_LICENSE_KEY \
  --build-arg CLOAK_VERSION=<build> \
  --build-arg CLOAK_URL='https://…/{version}/….tar.gz' \
  --build-arg CLOAK_SHA256=<sha256 of the archive> \
  -t tl.invalid/browser-profile:<build> apps/browser-profile
```

Offline: put the archive at `vendor/cloakbrowser-<build>-linux-x64.tar.gz` and leave `CLOAK_URL` empty. Archives in
`vendor/` are git-ignored. `CLOAK_BINARY_NAME` (default `chrome`) names the executable inside the archive.

Bumping `CLOAK_VERSION` changes every profile's user agent, which is a device change: roll it like a release, one
profile first (ADR-0001).

For work on the supervisor or the probe without a key, on any architecture, build the stock-Chromium variant. It
has no fingerprinting, so the probe's seed checks fail on it by design:

```sh
docker buildx build --build-arg ENGINE=chromium -t tl.invalid/browser-profile:chromium apps/browser-profile
```

## Probe (`scripts/browser-probe.ts`)

Runs on `browser-1` (Node 22.18+ and Docker; no `pnpm install` needed). Never in CI, never against Reddit.
Pass the seccomp profile the agent will use with `--docker-opt=--security-opt=seccomp=<file>`.

```sh
CLOAKBROWSER_LICENSE_KEY=… node scripts/browser-probe.ts --image tl.invalid/browser-profile:<build>
```

It starts seed A, reads it, restarts the container on the same volume and reads again, starts seed B on a fresh
volume, then starts one more container with the network removed (`--license-block network`, or
`--license-block hosts --license-host <host>` to block only the license host) and waits for exit 78. Each reading
is `navigator.webdriver`, UA, `navigator.platform`, client hints (high entropy), WebGL vendor and renderer, a canvas
hash, an audio hash, screen, time zone and the exit IP as the page sees it. CDP is published on `127.0.0.1` only for
the probe's containers, which it removes at the end (`--keep` leaves them).

Checks (the T13 "Done when"): webdriver false; UA, `navigator.platform` and client hints match the persona with no
`HeadlessChrome` and no software GPU; one seed is identical across the restart; two seeds differ; exit IP read from
the page (and differs from the node's when `PROBE_PROXY_URL` is set); exit 78 with the license host blocked.
`--json` prints the whole result for the PR. One-off reading from a running endpoint: `--cdp http://127.0.0.1:9222`.
