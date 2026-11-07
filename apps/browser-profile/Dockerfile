# One container per BrowserProfile: Chromium + Xvfb + x11vnc + websockify (noVNC), driven over CDP.
# Built with `pnpm browser:build`; started by apps/worker/src/browser/manager.ts (M6).
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc websockify novnc fonts-inter fonts-noto-color-emoji ca-certificates nodejs tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -u 1000 browser && mkdir -p /data && chown browser /data
COPY supervisor.mjs /opt/supervisor.mjs
USER browser
ENV DISPLAY=:99 SCREEN=1512x982 CDP_PORT=9222 VNC_PORT=6080 TZ=UTC LANG=en_US.UTF-8 PROXY_URL=
VOLUME ["/data"]
EXPOSE 9222 6080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/supervisor.mjs"]
