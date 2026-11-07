/** Reddit page fixtures under `tests/fixtures/reddit-pages` (see the README there for provenance). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REDDIT_PAGES_DIR = fileURLToPath(
  new URL('../../../tests/fixtures/reddit-pages/', import.meta.url),
);

export const REDDIT_PAGES = {
  thread: 'thread.html',
  commentBox: 'comment-box.html',
  dmCompose: 'dm-compose.html',
  verificationWall: 'verification-wall.html',
  loginWall: 'login-wall.html',
  captchaWall: 'captcha-wall.html',
} as const;
export type RedditPage = keyof typeof REDDIT_PAGES;

/** Ids baked into the fixtures, for assertions. */
export const FIXTURE_IDS = {
  subreddit: 'testkit_sandbox',
  postFullname: 't3_1abc2de',
  commentFullnames: ['t1_kx1aa01', 't1_kx1aa02'],
  /** the logged-in account shown in the header */
  username: 'testkit_poster',
} as const;

export function redditPagePath(page: RedditPage): string {
  return `${REDDIT_PAGES_DIR}${REDDIT_PAGES[page]}`;
}

export function readRedditPage(page: RedditPage): string {
  return readFileSync(redditPagePath(page), 'utf8');
}
