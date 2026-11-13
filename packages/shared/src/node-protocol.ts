/**
 * Gateway ↔ browser-node agent protocol, v1 (docs/plans/0001-infra-implementation.md §3.4).
 *
 * Transport: `wss://nodes.<domain>/agent`, subprotocol `tl-node.v1`, headers
 * `Authorization: Bearer <NODE_TOKEN>` and `X-Node-Name: <name>`. JSON text frames, each validated with
 * these schemas on both ends; a frame that fails validation (including an unknown `type`) closes the
 * socket with 4400.
 *
 * Semantics:
 * - `cmdId` is the BullMQ job id. The agent keeps the last {@link RESULT_CACHE_SIZE} `cmdId → Result` and
 *   replays a stored result instead of re-running a command (reconnect-and-retry is safe for posting).
 * - The agent sends `ack` within {@link ACK_TIMEOUT_MS} and `result` within `deadlineMs` (a duration in ms,
 *   counted from when the agent receives the command, so clock skew does not matter). The gateway fails the
 *   job as retryable `NodeTimeout` after the deadline, or `NodeDisconnected` if the socket closes first.
 * - {@link MISSED_HEARTBEATS_OFFLINE} missed heartbeats (45 s) mark the node `offline`.
 * - VNC: on `vnc.open` the agent dials `upstreamUrl` and pipes binary frames to
 *   `ws://tl-profile-<id>:6080/websockify`. No other inbound path exists.
 */
import { z } from 'zod';
import { BrowserCookie } from './cookies';
import { BrowserOutcome, CloakGpu, CloakPersona, NodeEventKind, WebRtcMode } from './enums';

export const PROTOCOL_VERSION = 1;
export const SUBPROTOCOL = 'tl-node.v1';
export const AGENT_PATH = '/agent';
export const NODE_NAME_HEADER = 'x-node-name';
export const HEARTBEAT_SEC = 15;
export const MISSED_HEARTBEATS_OFFLINE = 3;
export const ACK_TIMEOUT_MS = 2_000;
export const RESULT_CACHE_SIZE = 500;
/** Lifetime of the HMAC token in `vnc.open`. */
export const VNC_TOKEN_TTL_SEC = 60;

export const CloseCode = {
  protocolError: 4400,
  badToken: 4401,
  duplicateNode: 4409,
  protocolVersion: 4426,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Node names are DNS-ish labels: also used in queue names, container names and env var names. */
export const NodeName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'node name: lowercase letters, digits and dashes');

/** Gateway env var that holds a node's token: `browser-1` → `NODE_TOKEN_BROWSER_1`. */
export function nodeTokenEnvName(nodeName: string): string {
  return `NODE_TOKEN_${NodeName.parse(nodeName).toUpperCase().replace(/-/g, '_')}`;
}

const id = z.string().min(1);
const count = z.number().int().nonnegative();

// ── shared pieces ──

/** A profile container the agent has running. `startedAt` is epoch ms on the agent's clock. */
export const ProfileRef = z.object({ profileId: id, startedAt: z.number().int().nonnegative() });
export type ProfileRef = z.infer<typeof ProfileRef>;

/** CloakBrowser seats: `limit` is null when the license tier reports no cap. */
export const Seats = z.object({ inUse: count, limit: count.nullable() });
export type Seats = z.infer<typeof Seats>;

export const ProxySpec = z.object({
  protocol: z.enum(['http', 'socks5']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  username: z.string().optional(),
  password: z.string().optional(),
});
export type ProxySpec = z.infer<typeof ProxySpec>;

// ── commands (gateway → agent, inside `command`) ──

export const ProfileStartCmd = z.object({
  kind: z.literal('profile.start'),
  profileId: id,
  seed: z.number().int().nonnegative(),
  persona: z.enum(CloakPersona),
  gpu: z.enum(CloakGpu),
  /** IANA time zone, e.g. `America/New_York` */
  tz: z.string().min(1),
  /** BCP 47, e.g. `en-US` */
  locale: z.string().min(1),
  /** `<width>x<height>`, e.g. `1920x1080` */
  screen: z.string().regex(/^\d{3,5}x\d{3,5}$/),
  proxy: ProxySpec.nullable(),
  // Plan 0004 phase 2. All optional: absent = what the seed gives / the behaviour before these existed.
  /** `navigator.hardwareConcurrency` */
  cpu: z.number().int().min(1).max(64).optional(),
  /** `navigator.deviceMemory` in GB */
  memoryGb: z.number().int().min(1).max(64).optional(),
  /** false turns the canvas / WebGL / audio noise off; the seed still fixes the device */
  noise: z.boolean().optional(),
  /** WebRTC behind the proxy; `ip` = the proxy's exit IP for `replace` (absent: the engine looks it up) */
  webrtc: z.object({ mode: z.enum(WebRtcMode), ip: z.string().ip().optional() }).optional(),
});
export const ProfileStopCmd = z.object({ kind: z.literal('profile.stop'), profileId: id });
/**
 * Plan 0004. Stops the profile's container and deletes its volume: cookies, cache and the fingerprint lock are
 * gone for good. Sent when a trashed browser is purged, or its data is reset. A missing container or volume is
 * not an error.
 */
export const ProfileRemoveCmd = z.object({ kind: z.literal('profile.remove'), profileId: id });
export const SubmitCommentCmd = z.object({
  kind: z.literal('action.submitComment'),
  profileId: id,
  draftId: id,
  threadUrl: z.string().url(),
  /** `t3_…` (the post) or `t1_…` (a comment) */
  parentFullname: z.string().regex(/^t[13]_[a-z0-9]+$/i),
  body: z.string().min(1),
});
export const SendDmCmd = z.object({
  kind: z.literal('action.sendDm'),
  profileId: id,
  draftId: id,
  to: z.string().min(1),
  subject: z.string(),
  body: z.string().min(1),
});
export const TestProxyCmd = z.object({ kind: z.literal('profile.testProxy'), profileId: id });
export const VncOpenCmd = z.object({
  kind: z.literal('vnc.open'),
  profileId: id,
  sessionId: id,
  /** `wss://nodes.<domain>/vnc/<sessionId>?t=<token>` */
  upstreamUrl: z.string().url(),
  /** HMAC, valid {@link VNC_TOKEN_TTL_SEC} s */
  token: z.string().min(1),
});
export const HealthCheckCmd = z.object({ kind: z.literal('health.check') });
/**
 * Reads the Reddit identity of whoever is signed in to the profile's browser
 * (`https://www.reddit.com/api/me.json` inside the profile's own context: its cookies, its proxy).
 * Result data: {@link WhoamiData}. The agent never logs the response body.
 */
export const ProfileWhoamiCmd = z.object({ kind: z.literal('profile.whoami'), profileId: id });

/**
 * Plan 0003. Prepares a profile's browser for its assigned account, in order: import `cookies` into the profile's
 * context; read `me.json`; when nobody is signed in and `credentials` are given, fill reddit.com/login (and the
 * TOTP code from `totpSecret`) and read `me.json` again; leave a tab open on `startUrl` for the live view.
 * Result data: {@link WhoamiData}. Captcha / verification walls → `needs_human` with the tab kept.
 * Carries secrets: built only by the gateway at dispatch time, never logged, never stored in a result.
 */
export const ProfileSignInCmd = z.object({
  kind: z.literal('profile.signIn'),
  profileId: id,
  startUrl: z.string().url(),
  cookies: z.array(BrowserCookie).max(500).optional(),
  credentials: z
    .object({
      username: z.string().min(1).max(64),
      password: z.string().min(1).max(256),
      /** base32 */
      totpSecret: z.string().min(1).max(128).optional(),
    })
    .optional(),
});

export const Cmd = z.discriminatedUnion('kind', [
  ProfileStartCmd,
  ProfileStopCmd,
  ProfileRemoveCmd,
  SubmitCommentCmd,
  SendDmCmd,
  TestProxyCmd,
  VncOpenCmd,
  HealthCheckCmd,
  ProfileWhoamiCmd,
  ProfileSignInCmd,
]);
export type Cmd = z.infer<typeof Cmd>;
export type CmdKind = Cmd['kind'];
export type CmdOf<K extends CmdKind> = Extract<Cmd, { kind: K }>;

// ── result payloads (`Result.data`) for commands that return data ──

/** `profile.testProxy` → exit IP seen from the page and from the agent. */
export const TestProxyData = z.object({
  pageIp: z.string().min(1),
  agentIp: z.string().min(1),
  /** ms for the agent's IP echo through the proxy */
  latencyMs: z.number().int().nonnegative().optional(),
  /** reddit.com answered through the proxy (any status below 500) */
  redditOk: z.boolean().optional(),
  /** where the exit IP is, from the agent's geo lookup through the proxy; absent when the lookup failed */
  geo: z
    .object({
      city: z.string().max(120).optional(),
      country: z.string().max(80).optional(),
      timeZone: z.string().max(64).optional(),
      lat: z.number().min(-90).max(90).optional(),
      lon: z.number().min(-180).max(180).optional(),
    })
    .optional(),
});
export type TestProxyData = z.infer<typeof TestProxyData>;

/** `health.check` */
export const HealthData = z.object({
  running: z.array(ProfileRef),
  seats: Seats,
  docker: z.enum(['ok', 'error']),
});
export type HealthData = z.infer<typeof HealthData>;

/**
 * `profile.whoami` with outcome `ok`: nobody signed in, or the signed-in Reddit user. `id` is the base-36
 * account id without the `t2_` prefix (what `me.json` returns); `createdUtc` is epoch seconds.
 */
export const WhoamiData = z.discriminatedUnion('loggedIn', [
  z.object({ loggedIn: z.literal(false) }).strict(),
  z
    .object({
      loggedIn: z.literal(true),
      name: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'reddit username'),
      id: z.string().regex(/^[a-z0-9]{1,16}$/, 'reddit account id (base 36, no t2_ prefix)'),
      totalKarma: z.number().int().optional(),
      createdUtc: z.number().nonnegative().optional(),
    })
    .strict(),
]);
export type WhoamiData = z.infer<typeof WhoamiData>;

/** `action.submitComment` / `action.sendDm` with outcome `posted` → the new item's fullname. */
export const PostedData = z.object({ fullname: z.string().min(1) });
export type PostedData = z.infer<typeof PostedData>;

// ── agent → gateway ──

export const Hello = z.object({
  type: z.literal('hello'),
  node: NodeName,
  agentVersion: z.string().min(1),
  /** digest of the browser-profile image; null before the image is pulled */
  imageDigest: z.string().min(1).nullable(),
  maxProfiles: z.number().int().positive(),
  seats: Seats,
  running: z.array(ProfileRef),
});
export const Heartbeat = z.object({
  type: z.literal('heartbeat'),
  /** epoch ms on the agent's clock */
  ts: z.number().int().nonnegative(),
  running: z.array(ProfileRef),
  seats: Seats,
});
export const Ack = z.object({ type: z.literal('ack'), cmdId: id });
export const ResultError = z.object({ code: z.string().min(1), message: z.string() });
export const Result = z.object({
  type: z.literal('result'),
  cmdId: id,
  outcome: z.enum(BrowserOutcome),
  data: z.unknown().optional(),
  error: ResultError.optional(),
});
export const NodeEvent = z.object({
  type: z.literal('event'),
  profileId: id,
  kind: z.enum(NodeEventKind),
  detail: z.unknown().optional(),
});

export const AgentMessage = z.discriminatedUnion('type', [Hello, Heartbeat, Ack, Result, NodeEvent]);
export type AgentMessage = z.infer<typeof AgentMessage>;
export type Hello = z.infer<typeof Hello>;
export type Heartbeat = z.infer<typeof Heartbeat>;
export type Ack = z.infer<typeof Ack>;
export type ResultError = z.infer<typeof ResultError>;
export type Result = z.infer<typeof Result>;
export type NodeEvent = z.infer<typeof NodeEvent>;

// ── gateway → agent ──

export const Welcome = z.object({
  type: z.literal('welcome'),
  /** epoch ms on the gateway's clock */
  serverTime: z.number().int().nonnegative(),
  heartbeatSec: z.number().int().positive(),
  protocol: z.number().int().positive(),
});
export const Command = z.object({
  type: z.literal('command'),
  cmdId: id,
  /** time budget in ms for the result, from receipt */
  deadlineMs: z.number().int().positive(),
  cmd: Cmd,
});

export const GatewayMessage = z.discriminatedUnion('type', [Welcome, Command]);
export type GatewayMessage = z.infer<typeof GatewayMessage>;
export type Welcome = z.infer<typeof Welcome>;
export type Command = z.infer<typeof Command>;

// ── framing helpers ──

export type Parsed<T> =
  | { ok: true; msg: T }
  | { ok: false; closeCode: typeof CloseCode.protocolError; error: string };

/** Accepts what `ws` hands a message listener: string, Buffer/Uint8Array, ArrayBuffer or Buffer[]. */
function frameText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const dec = new TextDecoder('utf-8', { fatal: true });
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) return dec.decode(raw);
  if (Array.isArray(raw) && raw.every((p) => p instanceof Uint8Array)) {
    const parts = raw as Uint8Array[];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return dec.decode(all);
  }
  throw new Error('expected a text frame');
}

function parseFrame<T>(schema: z.ZodType<T>, raw: unknown): Parsed<T> {
  let value: unknown;
  try {
    value = JSON.parse(frameText(raw));
  } catch {
    // Not the parser's message: Node's JSON errors quote part of the input.
    return { ok: false, closeCode: CloseCode.protocolError, error: 'not a UTF-8 JSON text frame' };
  }
  const r = schema.safeParse(value);
  if (!r.success) {
    // Only paths and messages: never echo the frame, it may carry proxy credentials.
    const error = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, closeCode: CloseCode.protocolError, error };
  }
  return { ok: true, msg: r.data };
}

/** Gateway side: parse a frame from an agent. On `ok: false`, close the socket with `closeCode`. */
export const parseAgentMessage = (raw: unknown) => parseFrame(AgentMessage, raw);
/** Agent side: parse a frame from the gateway. On `ok: false`, close the socket with `closeCode`. */
export const parseGatewayMessage = (raw: unknown) => parseFrame(GatewayMessage, raw);

/** Validate then serialize, so a sender cannot put an off-contract frame on the wire. */
export const encodeAgentMessage = (m: AgentMessage) => JSON.stringify(AgentMessage.parse(m));
export const encodeGatewayMessage = (m: GatewayMessage) => JSON.stringify(GatewayMessage.parse(m));
