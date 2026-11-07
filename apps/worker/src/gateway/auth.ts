/**
 * Node agent authentication for the gateway (docs/plans/0001-infra-implementation.md §3.4, §3.5).
 *
 * An agent dials `wss://nodes.<domain>/agent` with subprotocol `tl-node.v1`, `Authorization: Bearer <NODE_TOKEN>`
 * and `X-Node-Name: <name>`. The token is checked against `BrowserNode.tokenHash` through `nodes.verifyToken`
 * (sha256, constant-time). Tokens are never logged or put in close reasons.
 */
import type { IncomingMessage } from 'node:http';
import { nodes } from '@threadline/db';
import { CloseCode, NODE_NAME_HEADER, NodeName, SUBPROTOCOL, nodeTokenEnvName } from '@threadline/shared';

export type NodeRow = nodes.NodeRow;
export type VerifyToken = (name: string, token: string) => Promise<NodeRow | null>;

export interface Credentials {
  name: string;
  token: string;
}

export type AuthResult = { ok: true; node: NodeRow } | { ok: false; closeCode: CloseCode; reason: string };

const PROTOCOL_FAMILY = 'tl-node.';

/**
 * `ws` `handleProtocols`: pick `tl-node.v1` when offered. Any other `tl-node.*` is still accepted at the
 * handshake so the gateway can close it with 4426 (a clear "upgrade your agent") instead of a failed handshake.
 */
export function pickSubprotocol(offered: Set<string>): string | false {
  if (offered.has(SUBPROTOCOL)) return SUBPROTOCOL;
  for (const p of offered) if (p.startsWith(PROTOCOL_FAMILY)) return p;
  return false;
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (typeof v !== 'string') return null; // missing, or sent more than once
  const t = v.trim();
  return t ? t : null;
}

/** Reads `X-Node-Name` and the bearer token. Null when either is missing or malformed. */
export function readCredentials(req: IncomingMessage): Credentials | null {
  const name = header(req, NODE_NAME_HEADER);
  const auth = header(req, 'authorization');
  if (!name || !auth) return null;
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  return { name, token: m[1]! };
}

/**
 * Decides whether an upgraded socket may stay open. Order: protocol version (4426), then credentials (4401).
 * The duplicate-name check (4409) is the hub's, because only it knows who is connected.
 */
export async function authenticate(
  req: IncomingMessage,
  protocol: string,
  verify: VerifyToken = nodes.verifyToken,
): Promise<AuthResult> {
  if (protocol !== SUBPROTOCOL)
    return { ok: false, closeCode: CloseCode.protocolVersion, reason: `expected subprotocol ${SUBPROTOCOL}` };
  const creds = readCredentials(req);
  if (!creds)
    return { ok: false, closeCode: CloseCode.badToken, reason: 'missing node name or bearer token' };
  const node = await verify(creds.name, creds.token);
  if (!node) return { ok: false, closeCode: CloseCode.badToken, reason: 'bad node token' };
  return { ok: true, node };
}

const ENV_PREFIX = 'NODE_TOKEN_';

/** `NODE_TOKEN_BROWSER_1` → `browser-1`; null when the suffix is not a valid node name. */
export function nodeNameFromEnv(envName: string): string | null {
  if (!envName.startsWith(ENV_PREFIX)) return null;
  const name = envName.slice(ENV_PREFIX.length).toLowerCase().replace(/_/g, '-');
  return NodeName.safeParse(name).success && nodeTokenEnvName(name) === envName ? name : null;
}

/**
 * Startup check for the `NODE_TOKEN_<NAME>` gateway variables (§3.5): each must match the stored hash of the
 * node it names. Auth itself only trusts the database; this only reports drift (e.g. a token rotated in the
 * database but not in Railway). Returns the env var names that do not match, never the tokens.
 */
export async function checkEnvTokens(
  env: NodeJS.ProcessEnv = process.env,
  verify: VerifyToken = nodes.verifyToken,
): Promise<{ ok: string[]; mismatched: string[] }> {
  const ok: string[] = [];
  const mismatched: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const name = nodeNameFromEnv(key);
    if (!name || !value) continue;
    if (await verify(name, value)) ok.push(key);
    else mismatched.push(key);
  }
  return { ok: ok.sort(), mismatched: mismatched.sort() };
}
