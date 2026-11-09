import { canLaunchChromium } from '@threadline/node-testkit/fake-cdp';
import { type Browser, type Page, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY_DELAY_MS, humanClick, humanFill, keyDelays, typeText } from './human';

/** Deterministic [0, 1) sequence (LCG). */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe('keyDelays', () => {
  it('gives every character a varying delay within the human range', () => {
    const d = keyDelays('abcdefghij', seeded(), 60_000);
    expect(d).toHaveLength(10);
    expect(new Set(d).size).toBeGreaterThan(5);
    for (const v of d) expect(v).toBeGreaterThanOrEqual(KEY_DELAY_MS.min);
  });

  it('pauses longer after punctuation than after a letter on average', () => {
    const r = seeded(3);
    const avg = (s: string) => keyDelays(s, r, 1e9).reduce((a, b) => a + b, 0) / s.length;
    expect(avg('.'.repeat(200))).toBeGreaterThan(avg('a'.repeat(200)) + 100);
  });

  it('scales a long text down to the budget', () => {
    const d = keyDelays('x'.repeat(2_000), seeded(), 25_000);
    const total = d.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(25_000 + d.length); // rounding
    expect(total).toBeGreaterThan(20_000);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(keyDelays('hi 👋', seeded(), 1e9)).toHaveLength(4);
  });
});

const available = await canLaunchChromium();

describe.skipIf(!available)('human input in a real page', () => {
  let browser: Browser;
  let page: Page;
  const fast = { sleep: async () => {}, random: seeded(11) };

  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: process.env.TESTKIT_CHROMIUM_PATH || undefined,
      headless: true,
    });
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  });

  afterAll(async () => {
    await browser?.close();
  });

  const record = () =>
    page.setContent(`<!doctype html><body style="margin:0">
      <input id="f" style="position:absolute;left:400px;top:300px;width:300px;height:40px">
      <textarea id="t" style="position:absolute;left:100px;top:500px;width:400px;height:100px"></textarea>
      <button id="b" style="position:absolute;left:800px;top:600px;width:120px;height:40px">Send</button>
      <script>
        window.ev = { keydown: 0, input: 0, moves: [], clicks: [] };
        addEventListener('keydown', () => ev.keydown++, true);
        addEventListener('input', () => ev.input++, true);
        addEventListener('mousemove', (e) => ev.moves.push([e.clientX, e.clientY]), true);
        addEventListener('click', (e) => ev.clicks.push([e.clientX, e.clientY, e.target.id]), true);
      </script></body>`);

  type Ev = { keydown: number; input: number; moves: number[][]; clicks: [number, number, string][] };
  const ev = () => page.evaluate(() => (globalThis as unknown as { ev: Ev }).ev);

  it('fills a field with one key press per character, replacing what was there', async () => {
    await record();
    await page.locator('#f').fill('old value');
    await page.evaluate(() => {
      (globalThis as unknown as { ev: Ev }).ev.keydown = 0;
    });
    await humanFill(page, page.locator('#f'), 'hunter2!', fast);
    expect(await page.locator('#f').inputValue()).toBe('hunter2!');
    expect((await ev()).keydown).toBeGreaterThanOrEqual('hunter2!'.length);
  });

  it('types multi-line text with Enter for newlines', async () => {
    await record();
    await humanClick(page, page.locator('#t'), fast);
    await typeText(page, 'Line one.\nLine two 👋', fast);
    expect(await page.locator('#t').inputValue()).toBe('Line one.\nLine two 👋');
    expect((await ev()).input).toBeGreaterThan(10);
  });

  it('moves the pointer along a path and clicks off-centre inside the target', async () => {
    await record();
    await humanClick(page, page.locator('#b'), fast);
    const { moves, clicks } = await ev();
    expect(moves.length).toBeGreaterThanOrEqual(8);
    expect(clicks).toHaveLength(1);
    const [x, y, id] = clicks[0]!;
    expect(id).toBe('b');
    expect(x).toBeGreaterThanOrEqual(800);
    expect(x).toBeLessThanOrEqual(920);
    expect(y).toBeGreaterThanOrEqual(600);
    expect(y).toBeLessThanOrEqual(640);
    // Not a straight line: some intermediate point is off the chord from the first move to the click.
    const [x0, y0] = moves[0]!;
    const off = moves.map(([mx, my]) => {
      const cross = (x - x0!) * (my! - y0!) - (y - y0!) * (mx! - x0!);
      return Math.abs(cross) / Math.hypot(x - x0!, y - y0!);
    });
    expect(Math.max(...off)).toBeGreaterThan(2);
  });
});
