// Tiny supervisor: starts Xvfb, Chromium (persistent /data profile, proxy, CDP), x11vnc and websockify.
// Proxy auth (PROXY_USER/PROXY_PASS) is answered by the worker's Playwright driver via CDP Fetch.authRequired.
import { spawn } from 'node:child_process';

const env = process.env;
const [w, h] = (env.SCREEN || '1512x982').split('x');
const run = (cmd, args) => {
  const p = spawn(cmd, args, { stdio: 'inherit' });
  p.on('exit', (code) => {
    console.error(`${cmd} exited with ${code}; stopping container`);
    process.exit(code ?? 1);
  });
  return p;
};

run('Xvfb', [env.DISPLAY || ':99', '-screen', '0', `${w}x${h}x24`, '-nolisten', 'tcp']);
setTimeout(() => {
  const chromeArgs = [
    `--user-data-dir=/data/chromium`,
    `--remote-debugging-address=0.0.0.0`,
    `--remote-debugging-port=${env.CDP_PORT || 9222}`,
    `--window-size=${w},${h}`,
    `--lang=${(env.LANG || 'en-US').split('.')[0].replace('_', '-')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
  ];
  if (env.PROXY_URL) chromeArgs.push(`--proxy-server=${env.PROXY_URL}`);
  run('chromium', chromeArgs);
  run('x11vnc', ['-display', env.DISPLAY || ':99', '-forever', '-shared', '-nopw', '-localhost', '-rfbport', '5900', '-quiet']);
  run('websockify', ['--web', '/usr/share/novnc', String(env.VNC_PORT || 6080), 'localhost:5900']);
}, 800);
