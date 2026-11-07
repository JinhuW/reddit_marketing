/**
 * Node agent configuration, read once from the environment (docs/plans/0001-infra-implementation.md §3.5).
 * The agent has no database access: everything it needs comes from env or from gateway commands.
 */
import { AGENT_PATH, NodeName } from '@threadline/shared';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };

const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/** `wss://nodes.<domain>` or `wss://nodes.<domain>/agent`; a bare origin gets `/agent` appended. */
const GatewayUrl = z
  .string()
  .url()
  .refine((u) => /^wss?:$/.test(new URL(u).protocol), 'GATEWAY_URL must be ws:// or wss://')
  .transform((u) => {
    const url = new URL(u);
    if (url.pathname === '' || url.pathname === '/') url.pathname = AGENT_PATH;
    return url.toString();
  });

export const EnvSchema = z.object({
  GATEWAY_URL: GatewayUrl,
  NODE_NAME: NodeName,
  NODE_TOKEN: z.string().min(16, 'NODE_TOKEN must be at least 16 characters'),
  /** Passed to profile containers only; never logged. Optional so the agent can connect before G2. */
  CLOAKBROWSER_LICENSE_KEY: z.string().min(1).optional(),
  /** Pinned browser-profile image, ideally `repo@sha256:…`. */
  BROWSER_IMAGE: z.string().min(1).default('threadline/browser-profile:latest'),
  BROWSER_NETWORK: z.string().min(1).default('tl-browsers'),
  NODE_MAX_PROFILES: z.coerce.number().int().positive().default(8),
  LOG_LEVEL: LogLevel.default('info'),
  /** Overrides the package version reported in `hello` (CI sets the image tag). */
  AGENT_VERSION: z.string().min(1).optional(),
});

export interface AgentConfig {
  gatewayUrl: string;
  nodeName: string;
  nodeToken: string;
  cloakLicenseKey: string | undefined;
  browserImage: string;
  browserNetwork: string;
  maxProfiles: number;
  logLevel: z.infer<typeof LogLevel>;
  agentVersion: string;
}

export class ConfigError extends Error {}

/** Parse the environment. Error messages name variables, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid node agent environment: ${issues}`);
  }
  const e = r.data;
  return {
    gatewayUrl: e.GATEWAY_URL,
    nodeName: e.NODE_NAME,
    nodeToken: e.NODE_TOKEN,
    cloakLicenseKey: e.CLOAKBROWSER_LICENSE_KEY,
    browserImage: e.BROWSER_IMAGE,
    browserNetwork: e.BROWSER_NETWORK,
    maxProfiles: e.NODE_MAX_PROFILES,
    logLevel: e.LOG_LEVEL,
    agentVersion: e.AGENT_VERSION ?? pkg.version,
  };
}

/** Values that must never reach a log line, an error message or a result sent to the gateway. */
export function secretValues(config: AgentConfig): string[] {
  return [config.nodeToken, config.cloakLicenseKey].filter((s): s is string => !!s);
}
