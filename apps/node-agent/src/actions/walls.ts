/** Verification, captcha and login walls: any of them turns an action into `needs_human` (PLAN §14). */
import type { Page } from 'playwright-core';
import { wallPaths, walls } from './selectors';

export type Wall = 'verification' | 'captcha' | 'login';

/** The wall `page` shows right now, or null. Captcha is checked first: it can sit on top of any page. */
export async function detectWall(page: Page): Promise<Wall | null> {
  for (const wall of ['captcha', 'verification', 'login'] as const) {
    if ((await page.locator(walls[wall]).count()) > 0) return wall;
  }
  let path = '';
  try {
    path = new URL(page.url()).pathname;
  } catch {
    return null;
  }
  return wallPaths.find((w) => w.re.test(path))?.wall ?? null;
}
