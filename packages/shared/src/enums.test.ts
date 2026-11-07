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
  ] as const;
  for (const n of names) {
    it(n, () => expect(prismaEnum(n)).toEqual([...(E as unknown as Record<string, readonly string[]>)[n]!]));
  }
});
