/**
 * Logging for the node agent. Two layers keep secrets out of logs:
 * 1. pino `redact` censors well-known keys (`password`, `token`, `CLOAKBROWSER_LICENSE_KEY`, …) at any of the
 *    first three levels of a log object, e.g. `{ cmd: { proxy: { password } } }`.
 * 2. Every known secret *value* (node token, license key, proxy passwords seen in commands) is replaced with
 *    `[Redacted]` wherever it appears in a string: the message, an error message or stack, any field.
 */
import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

export const REDACTED = '[Redacted]';

const SECRET_KEYS = [
  'password',
  'token',
  'CLOAKBROWSER_LICENSE_KEY',
  'NODE_TOKEN',
  'nodeToken',
  'cloakLicenseKey',
  'authorization',
  'Authorization',
];

export const REDACT_PATHS = SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]);

/** Known secret values. Shared by the logger and by result/error scrubbing in dispatch. */
export class SecretSet {
  private readonly values = new Set<string>();

  constructor(initial: Iterable<string> = []) {
    for (const v of initial) this.add(v);
  }

  /** Short values are ignored: censoring "1" or "ab" everywhere would mangle logs and protect nothing. */
  add(value: string | null | undefined): void {
    if (value && value.length >= 4) this.values.add(value);
  }

  get size(): number {
    return this.values.size;
  }

  scrub(text: string): string {
    let out = text;
    for (const v of this.values) if (out.includes(v)) out = out.split(v).join(REDACTED);
    return out;
  }

  /** Deep copy with every string scrubbed. Cycles become `[Circular]`. */
  scrubDeep<T>(value: T, seen = new WeakSet<object>()): T {
    if (this.values.size === 0) return value;
    if (typeof value === 'string') return this.scrub(value) as T;
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]' as T;
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => this.scrubDeep(v, seen)) as T;
    if (value instanceof Error) {
      const copy = new Error(this.scrub(value.message));
      copy.name = value.name;
      copy.stack = value.stack ? this.scrub(value.stack) : undefined;
      return copy as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = this.scrubDeep(v, seen);
    return out as T;
  }
}

export interface LoggerOptions {
  level?: string;
  secrets?: SecretSet;
  /** Tests pass a stream to capture output; production logs JSON to stdout. */
  destination?: DestinationStream;
  base?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const secrets = opts.secrets ?? new SecretSet();
  return pino(
    {
      level: opts.level ?? 'info',
      base: opts.base ?? {},
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      serializers: { err: (e: unknown) => pino.stdSerializers.err(secrets.scrubDeep(e) as Error) },
      formatters: { log: (obj) => secrets.scrubDeep(obj) },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === 'string' ? secrets.scrub(a) : a));
          return method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
    },
    opts.destination ?? pino.destination(1),
  );
}
