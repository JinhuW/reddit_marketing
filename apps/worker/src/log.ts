import pino from 'pino';

/** Never log tokens: redact common secret paths. */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: [
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.password',
    'headers.authorization',
    'oauthTokenEnc',
  ],
});
