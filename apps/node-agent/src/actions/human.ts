/**
 * Human-paced input for actions. CloakBrowser hides what the browser is; it does nothing about how it is driven.
 * Playwright's `fill()` sets a field in one event with no key presses, `keyboard.insertText()` pastes a whole
 * comment at once, and `click()` teleports the pointer to the element's exact centre. Anti-bot scoring (Reddit's
 * login, reCAPTCHA) reads those as a script, so actions use these helpers instead.
 *
 * Every helper takes {@link HumanOptions}; tests pass a fixed `random` and a no-op `sleep` to stay fast and exact.
 */
import { setTimeout as timersSleep } from 'node:timers/promises';
import type { Locator, Page } from 'playwright-core';

export interface HumanOptions {
  /** [0, 1) source; default `Math.random`. */
  random?: () => number;
  /** Pause; default `timers/promises.setTimeout`. */
  sleep?: (ms: number) => Promise<unknown>;
  /** Upper bound for the whole typing of one value, in ms; default 25 s. Long text types faster to fit it. */
  typingBudgetMs?: number;
}

interface Resolved {
  random: () => number;
  sleep: (ms: number) => Promise<unknown>;
  typingBudgetMs: number;
}

const resolve = (o: HumanOptions = {}): Resolved => ({
  random: o.random ?? Math.random,
  sleep: o.sleep ?? ((ms) => timersSleep(ms)),
  typingBudgetMs: o.typingBudgetMs ?? 25_000,
});

/** Per-key delay range before scaling, in ms: roughly 60–90 wpm with variation. */
export const KEY_DELAY_MS = { min: 45, max: 160 } as const;

/** Where the pointer was left on each page; Playwright does not expose it. */
const pointers = new WeakMap<Page, { x: number; y: number }>();

const between = (r: () => number, min: number, max: number) => min + r() * (max - min);

/**
 * Moves the pointer to a random point inside the element (away from the edges, never the exact centre) along
 * a curved path, pauses briefly, then clicks there. Keeps Playwright's actionability checks.
 */
export async function humanClick(page: Page, target: Locator, opts?: HumanOptions): Promise<void> {
  const o = resolve(opts);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) {
    // Not laid out (e.g. zero size): fall back to Playwright's own click so the action still fails loudly.
    await target.click();
    return;
  }
  const x = box.x + box.width * between(o.random, 0.25, 0.75);
  const y = box.y + box.height * between(o.random, 0.3, 0.7);
  await moveMouse(page, { x, y }, o);
  await o.sleep(between(o.random, 60, 220));
  await target.click({
    position: { x: x - box.x, y: y - box.y },
    delay: Math.round(between(o.random, 40, 120)),
  });
}

/** Clicks into a field, clears it, and types `text` key by key (see {@link typeText}). Replaces `fill()`. */
export async function humanFill(
  page: Page,
  field: Locator,
  text: string,
  opts?: HumanOptions,
): Promise<void> {
  await humanClick(page, field, opts);
  // Clear whatever is there (autofill, an earlier attempt) like a person would: select all, delete.
  if ((await field.inputValue().catch(() => '')) !== '') {
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
  }
  await typeText(page, text, opts);
}

/**
 * Types into the focused element one key at a time with a varying delay, a longer pause after spaces and
 * punctuation, and an occasional "thinking" pause. When the text would take longer than `typingBudgetMs`, all
 * delays shrink in proportion so a long comment still fits the command deadline. Replaces `insertText()`.
 */
export async function typeText(page: Page, text: string, opts?: HumanOptions): Promise<void> {
  const o = resolve(opts);
  const delays = keyDelays(text, o.random, o.typingBudgetMs);
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    // `\n` through type() presses Enter, which starts a new paragraph in Reddit's composers.
    await page.keyboard.type(ch);
    const d = delays[i] ?? 0;
    if (d > 0) await o.sleep(d);
  }
}

/** Delay after each character of `text`, scaled so the sum stays within `budgetMs`. Exported for tests. */
export function keyDelays(text: string, random: () => number, budgetMs: number): number[] {
  const raw = [...text].map((ch) => {
    let d = between(random, KEY_DELAY_MS.min, KEY_DELAY_MS.max);
    if (ch === ' ') d += between(random, 20, 90);
    else if (/[.,!?;:\n]/.test(ch)) d += between(random, 120, 400);
    if (random() < 0.03) d += between(random, 300, 900); // a short hesitation
    return d;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  const scale = total > budgetMs && total > 0 ? budgetMs / total : 1;
  return raw.map((d) => Math.round(d * scale));
}

/** Moves along a quadratic Bézier with a random bend, in steps, from the last known pointer position. */
async function moveMouse(page: Page, to: { x: number; y: number }, o: Resolved): Promise<void> {
  const vp = page.viewportSize();
  const from = pointers.get(page) ?? {
    x: between(o.random, 0.2, 0.8) * (vp?.width ?? 1200),
    y: between(o.random, 0.2, 0.6) * (vp?.height ?? 800),
  };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // Control point: off the straight line by up to 30% of the distance, to either side.
  const bend = between(o.random, -0.3, 0.3) * dist;
  const len = dist || 1;
  const cx = from.x + dx / 2 + (-dy / len) * bend;
  const cy = from.y + dy / 2 + (dx / len) * bend;
  const steps = Math.max(8, Math.min(40, Math.round(dist / 25)));
  for (let i = 1; i <= steps; i++) {
    // Ease in and out: slow start, fast middle, slow arrival.
    const lin = i / steps;
    const t = lin < 0.5 ? 2 * lin * lin : 1 - (-2 * lin + 2) ** 2 / 2;
    const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * cx + t ** 2 * to.x;
    const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * cy + t ** 2 * to.y;
    await page.mouse.move(x, y);
    await o.sleep(between(o.random, 4, 16));
  }
  pointers.set(page, to);
}
