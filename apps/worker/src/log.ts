import pino from 'pino';

/** Never log tokens: redact common secret paths (defense in depth; code must not log secrets at all). */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: [
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.password',
    '*.totpSecret',
    '*.credentials',
    '*.cookies',
    '*.cookiesEnc',
    'headers.authorization',
    'oauthTokenEnc',
  ],
});
