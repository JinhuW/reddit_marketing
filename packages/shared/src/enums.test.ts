import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as E from './enums';

const schema = readFileSync(join(__dirname, '../../db/prisma/schema.prisma'), 'utf8');
const prismaEnum = (name: string) => {
  const m = schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  if (!m) throw new Error(`enum ${name} not in schema`);
  return m[1]!
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'));
};

describe('enums mirror prisma', () => {
  const names = [
    'Plan',
    'MemberRole',
    'AccountRoleLabel',
    'AccountHealth',
    'BrowserProfileStatus',
    'ProxyProtocol',
    'SessionDriver',
    'AgentStatus',
    'SkillKey',
    'ContextKind',
    'ConnectorProvider',
    'ConnectorStatus',
    'Intent',
    'LinkRule',
    'ModStatus',
    'OpportunityLevel',
    'OpportunityStatus',
    'DraftType',
    'DraftStatus',
    'LeadStage',
    'ConversationKind',
    'MessageDirection',
    'LinkMedium',
    'SiteEventKind',
    'AttributionModel',
    'BrowserNodeStatus',
    'PauseReason',
  ] as const;
  for (const n of names) {
    it(n, () => expect(prismaEnum(n)).toEqual([...(E as unknown as Record<string, readonly string[]>)[n]!]));
  }

  it('covers every enum declared in the Prisma schema', () => {
    const declared = [...schema.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1]!);
    expect([...declared].sort()).toEqual([...names].sort());
  });
});

describe('browser node enums', () => {
  it('AuditAction has the node and pause actions', () => {
    for (const a of [
      'node.online',
      'node.offline',
      'profile.started',
      'profile.stopped',
      'profile.license_denied',
      'profile.fingerprint_assigned',
      'account.paused',
      'account.resumed',
    ] as const) {
      expect(E.AuditAction).toContain(a);
    }
  });

  it('BrowserOutcome covers every pause reason the gateway maps', () => {
    for (const r of ['needs_human', 'license_denied', 'proxy_failed'] as const) {
      expect(E.BrowserOutcome).toContain(r);
      expect(E.PauseReason).toContain(r);
    }
  });
});
