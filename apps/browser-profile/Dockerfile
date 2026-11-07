# syntax=docker/dockerfile:1.7
# One container per BrowserProfile: CloakBrowser (headed, seeded fingerprint) under Xvfb, CDP front proxy on 9222,
# x11vnc + websockify (noVNC) on 6080. Started by the node agent (apps/node-agent, plan §4 T21); env contract in
# README.md. linux/amd64 only: CloakBrowser ships no arm64 build.
#
#   Pinned CloakBrowser build (the key is a BuildKit secret and never lands in a layer):
#     CLOAKBROWSER_LICENSE_KEY=… docker buildx build --platform linux/amd64 \
#       --secret id=cloak_key,env=CLOAKBROWSER_LICENSE_KEY \
#       --build-arg CLOAK_VERSION=<build> --build-arg CLOAK_URL='https://…/{version}/…tar.gz' \
#       --build-arg CLOAK_SHA256=<sha256> -t threadline/browser-profile:<build> apps/browser-profile
#     (or drop the archive in vendor/cloakbrowser-<build>-linux-x64.tar.gz and leave CLOAK_URL empty)
#
#   Stock Chromium, for local work on the supervisor and the probe (any arch, no key, no fingerprinting):
#     docker buildx build --build-arg ENGINE=chromium -t threadline/browser-profile:chromium apps/browser-profile
ARG ENGINE=cloak

# ---- shared runtime: X, VNC, Node for the supervisor, Chromium runtime libraries, fonts ---------------------------
FROM debian:bookworm-slim AS base
# Fonts: Windows-metric (Liberation = Arial/Times/Courier metrics, Carlito = Calibri, Caladea = Cambria),
# emoji and CJK, so the default `windows` persona renders text with Windows-like metrics.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc websockify novnc nodejs tini ca-certificates fontconfig \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxss1 libxshmfence1 libx11-xcb1 libgbm1 \
      libasound2 libpango-1.0-0 libcairo2 libgtk-3-0 libexpat1 libu2f-udev xdg-utils \
      fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core \
      fonts-noto-color-emoji fonts-noto-cjk \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -u 1000 browser && mkdir -p /data && chown browser /data \
  && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# ---- fetch the pinned CloakBrowser build (curl stays out of the final image) -------------------------------------
FROM debian:bookworm-slim AS fetch-cloak
ARG CLOAK_VERSION
ARG CLOAK_URL
ARG CLOAK_SHA256
ARG CLOAK_BINARY_NAME=chrome
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=cloak_key,required=false \
    --mount=type=bind,source=vendor,target=/vendor \
    set -eu; \
    [ "$(dpkg --print-architecture)" = amd64 ] || { echo 'CloakBrowser is linux/amd64 only: build with --platform linux/amd64' >&2; exit 1; }; \
    [ -n "${CLOAK_VERSION:-}" ] || { echo 'CLOAK_VERSION is required (one pinned build; never auto-download latest)' >&2; exit 1; }; \
    src="/vendor/cloakbrowser-${CLOAK_VERSION}-linux-x64.tar.gz"; \
    if [ ! -f "$src" ]; then \
      [ -n "${CLOAK_URL:-}" ] || { echo "Set CLOAK_URL or put $src in vendor/" >&2; exit 1; }; \
      url="$(printf '%s' "$CLOAK_URL" | sed "s/{version}/${CLOAK_VERSION}/g")"; \
      if [ -s /run/secrets/cloak_key ]; then \
        printf 'header = "Authorization: Bearer %s"\n' "$(cat /run/secrets/cloak_key)" > /tmp/curlrc; \
        curl -fsSL --config /tmp/curlrc -o /tmp/cloak.tar "$url"; rm -f /tmp/curlrc; \
      else \
        curl -fsSL -o /tmp/cloak.tar "$url"; \
      fi; \
      src=/tmp/cloak.tar; \
    fi; \
    if [ -n "${CLOAK_SHA256:-}" ]; then echo "${CLOAK_SHA256}  ${src}" | sha256sum -c -; \
    else echo 'warning: CLOAK_SHA256 not set; the archive is not verified' >&2; fi; \
    mkdir -p /opt/cloakbrowser/dist; \
    tar -xf "$src" -C /opt/cloakbrowser/dist; \
    rm -f /tmp/cloak.tar; \
    bin="$(find /opt/cloakbrowser/dist -type f -name "$CLOAK_BINARY_NAME" -perm -u+x | head -n 1)"; \
    [ -n "$bin" ] || { echo "no executable named $CLOAK_BINARY_NAME in the archive" >&2; exit 1; }; \
    ln -s "$bin" /opt/cloakbrowser/cloakbrowser; \
    printf '%s\n' "$CLOAK_VERSION" > /opt/cloakbrowser/VERSION

FROM base AS engine-cloak
COPY --from=fetch-cloak /opt/cloakbrowser /opt/cloakbrowser
ENV CLOAKBROWSER_BINARY_PATH=/opt/cloakbrowser/cloakbrowser

FROM base AS engine-chromium
RUN apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium

# ---- final -----------------------------------------------------------------------------------------------------
FROM engine-${ENGINE}
ARG ENGINE
COPY supervisor.mjs /opt/supervisor/supervisor.mjs
COPY lib/ /opt/supervisor/lib/
USER browser
WORKDIR /home/browser
# CLOAK_SEED / CLOAK_PERSONA / CLOAK_GPU / TZ / LOCALE / SCREEN / PROXY_URL / CLOAKBROWSER_LICENSE_KEY come from the
# node agent per profile. The key is never baked in.
ENV ENGINE=${ENGINE} DISPLAY=:99 SCREEN=1512x982 CDP_PORT=9222 CDP_INTERNAL_PORT=9223 VNC_PORT=6080 \
    TZ=UTC LANG=en_US.UTF-8 USER_DATA_DIR=/data/browser
VOLUME ["/data"]
EXPOSE 9222 6080
LABEL org.opencontainers.image.title="threadline-browser-profile" \
      org.opencontainers.image.description="CloakBrowser profile container for Threadline browser nodes"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/supervisor/supervisor.mjs"]
