/**
 * Every Reddit selector the actions use, in one place. They match the reconstructed markup in
 * `tests/fixtures/reddit-pages` (shreddit custom elements, composer slots, the compose form, the wall pages);
 * when Reddit changes its markup, re-capture the fixtures and update this file together.
 */

/** The logged-in account's name, from the header. */
export const USER_MENU = '#user-drawer-button[data-username]';

export const comment = {
  /** A comment by fullname. */
  byFullname: (fullname: string) => `shreddit-comment[thingid="${fullname}"]`,
  /** Direct replies to a post or comment. */
  childrenOf: (parent: string) => `shreddit-comment[parentid="${parent}"]`,
  /** Top-level composer host for a post. */
  topHost: (postFullname: string) => `comment-composer-host[parent-id="${postFullname}"]`,
  topTrigger: '.composer-trigger',
  /** A reply composer that belongs to a comment (not to one of its children). */
  ownComposer: ':scope > form.composer',
  replyButton: ':scope > button.reply',
  form: 'form.composer',
  textbox: '[role="textbox"][contenteditable="true"], textarea[name="body"]',
  submit: '[slot="submit-button"], button[type="submit"]',
  error: '[role="alert"]',
} as const;

export const dm = {
  form: 'form#compose-message, form[action$="/api/compose"]',
  to: '[name="to"]',
  subject: '[name="subject"]',
  text: 'textarea[name="text"], textarea[name="message"]',
  send: 'button[name="send"], button[type="submit"]',
  /** Status line; carries `data-message-id` once Reddit accepted the message. */
  sent: '.status[data-message-id]',
  failed: '.status.error, .error:not([hidden])',
} as const;

/** Walls a human must clear (PLAN §14: verification recovery is a take-over over VNC). */
export const walls = {
  captcha: [
    '.g-recaptcha',
    '.h-captcha',
    'textarea[name="g-recaptcha-response"]',
    'iframe[title*="recaptcha" i]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    '#captcha-form',
  ].join(', '),
  verification: ['input[autocomplete="one-time-code"]', '#email-verification', '#verify-form'].join(', '),
  login: ['form#login', 'input[type="password"][autocomplete="current-password"]', '#login-password'].join(
    ', ',
  ),
} as const;

/** Wall paths Reddit redirects content pages to. */
export const wallPaths: ReadonlyArray<{ wall: 'verification' | 'login'; re: RegExp }> = [
  { wall: 'verification', re: /^\/(account\/verify|verification)(\/|$)/ },
  { wall: 'login', re: /^\/(login|account\/login)(\/|$)/ },
];

/**
 * The reddit.com/login form (plan 0003 `profile.signIn`). Each field is a list of candidates, first visible match
 * wins: the live page renders faceplate web components (`faceplate-text-input#login-username` wrapping an
 * `<input>` in an open shadow root, which Playwright's CSS engine pierces), the fixture renders plain inputs.
 * Unverified against the live page in CI: re-check these when sign-in stops finding a field.
 */
export const signIn = {
  username: [
    'input[name="username"]',
    '#login-username input',
    'input#login-username',
    'input[autocomplete="username"]',
  ].join(', '),
  password: [
    'input[name="password"]',
    '#login-password input',
    'input#login-password',
    'input[type="password"][autocomplete="current-password"]',
  ].join(', '),
  /** The 2FA step's code field (authenticator app). */
  otp: [
    'input[name="otp"]',
    '#login-otp input',
    'input#login-otp',
    'input[name="appOtp"]',
    'input[autocomplete="one-time-code"]',
  ].join(', '),
  submit: ['button.login', 'button.check', 'button[type="submit"]'].join(', '),
  /** A rejected username / password or 2FA code. Matched on visible elements only. */
  error: ['[role="alert"]', '[slot="helper-text"][status="error"]', '.login-error', '.otp-error'].join(', '),
  errorText:
    /invalid username or password|incorrect (username|password)|wrong password|invalid (code|otp)|incorrect code|code (is )?(invalid|incorrect)/i,
  /** An e-mail / "verify it's you" check, as opposed to the 2FA step on the login page itself. */
  emailCheck: ['#email-verification', '#verify-form'].join(', '),
  /**
   * A captcha a human must solve. Narrower than `walls.captcha` on purpose: the live login page loads an
   * invisible reCAPTCHA (badge iframe), which is not a challenge.
   */
  challenge: [
    'iframe[src*="recaptcha"][src*="bframe"]',
    'iframe[title*="challenge" i]',
    'iframe[src*="hcaptcha"]',
    '.g-recaptcha:not([data-size="invisible"])',
    '.h-captcha:not([data-size="invisible"])',
    '#captcha-form',
  ].join(', '),
} as const;
