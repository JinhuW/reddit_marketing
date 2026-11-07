import { PrismaClient } from '@prisma/client';
/**
 * Seed = the mockup sample data (docs/design/*.dc.html): Acme workspace, 5 members, 3 agents,
 * 3 accounts, 5 subreddits, 4 keyword groups, 38 opportunities, 7 pending drafts, 12 leads,
 * 7 conversations, tracked links with click/site events, audit log and notifications.
 * All times are relative to "now" so the UI's "3h ago" copy stays true.
 * Run: pnpm db:seed (idempotent — it truncates first).
 */
import { evaluateDraft } from '@threadline/agents';
import { buildUtm, withUtm } from '@threadline/shared';
import { encrypt } from '@threadline/shared/crypto';

const prisma = new PrismaClient();
const NOW = new Date();
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hAgo = (h: number) => minAgo(h * 60);
const dAgo = (d: number) => hAgo(d * 24);

// deterministic PRNG so the seed is stable
let s = 42;
const rnd = () => {
  s = (s * 1664525 + 1013904223) % 4294967296;
  return s / 4294967296;
};
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;

async function truncateAll() {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`,
  );
  // TRUNCATE does not fire the AuditEvent append-only row trigger.
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
}

const enc = (v: string) => (process.env.APP_ENCRYPTION_KEY ? encrypt(v) : null);

async function main() {
  await truncateAll();

  const ws = await prisma.workspace.create({
    data: {
      name: 'Acme',
      slug: 'acme',
      plan: 'pro',
      settings: {
        product: 'Acme',
        siteUrl: 'https://acme.so',
        shortHost: 'acme.so',
        allowedOrigins: ['https://acme.so', 'http://localhost:3000'],
        timeZone: 'America/New_York',
        weeklyReport: { enabled: true, day: 'monday', recipients: ['jane@acme.so'] },
      },
    },
  });
  const W = { workspaceId: ws.id };
  // Agency tier placeholders (switcher shows "2 of 4" in the mockup; UI ships in M8)
  await prisma.workspace.create({
    data: { name: 'Acme Labs', slug: 'acme-labs', plan: 'starter', parentWorkspaceId: ws.id },
  });

  // ── members ──
  const people = [
    {
      key: 'jane',
      name: 'Jane Park',
      email: 'jane@acme.so',
      role: 'admin',
      canApprove: true,
      seen: minAgo(2),
    },
    {
      key: 'leo',
      name: 'Leo Martins',
      email: 'leo@acme.so',
      role: 'approver',
      canApprove: true,
      seen: hAgo(1),
    },
    {
      key: 'sam',
      name: 'Sam Okafor',
      email: 'sam@acme.so',
      role: 'editor',
      canApprove: false,
      seen: dAgo(1),
    },
    {
      key: 'mira',
      name: 'Mira Chen',
      email: 'mira@acme.so',
      role: 'editor',
      canApprove: false,
      seen: hAgo(3),
    },
    {
      key: 'rhea',
      name: 'Rhea Kapoor',
      email: 'rhea@brightloop.io',
      role: 'viewer',
      canApprove: false,
      seen: dAgo(3),
    },
  ] as const;
  const M: Record<string, string> = {};
  for (const p of people) {
    const u = await prisma.user.create({ data: { email: p.email, name: p.name, emailVerified: dAgo(60) } });
    const m = await prisma.workspaceMember.create({
      data: { ...W, userId: u.id, role: p.role, canApprove: p.canApprove, updatedAt: p.seen },
    });
    M[p.key] = m.id;
  }

  // ── subreddits ──
  const subDefs = [
    {
      name: 'projectmanagement',
      members: 412_000,
      activity: 0.7,
      selfPromoPolicy: 'Disclosed answers OK',
      linkRule: 'one_per_comment',
      modStatus: 'ok',
      notes: 'Mods approved disclosed answers (Oct 14).',
      minKarma: 100,
      minAccountAgeDays: 30,
    },
    {
      name: 'SaaS',
      members: 268_000,
      activity: 0.9,
      selfPromoPolicy: 'No self-promo in comments',
      linkRule: 'none',
      modStatus: 'unknown',
      notes: 'Not contacted.',
      minKarma: 50,
      minAccountAgeDays: 30,
    },
    {
      name: 'startups',
      members: 1_600_000,
      activity: 0.85,
      selfPromoPolicy: 'Self-promo Saturdays',
      linkRule: 'saturdays',
      modStatus: 'ok',
      notes: 'Feedback Friday / Self-promo Saturday threads.',
      minKarma: 200,
      minAccountAgeDays: 90,
    },
    {
      name: 'productivity',
      members: 3_100_000,
      activity: 0.6,
      selfPromoPolicy: 'Disclosed answers OK',
      linkRule: 'one_per_comment',
      modStatus: 'watch',
      notes: 'Mod reply pending.',
      minKarma: 100,
      minAccountAgeDays: 30,
    },
    {
      name: 'Entrepreneur',
      members: 4_400_000,
      activity: 0.95,
      selfPromoPolicy: 'No self-promo',
      linkRule: 'none',
      modStatus: 'banned',
      notes: 'Mods declined; advice-only replies.',
      minKarma: 500,
      minAccountAgeDays: 180,
    },
  ] as const;
  const SUB: Record<
    string,
    { id: string; name: string; linkRule: string; minKarma: number; minAccountAgeDays: number }
  > = {};
  for (const d of subDefs) {
    const r = await prisma.subreddit.create({ data: { ...W, ...d, rulesFetchedAt: hAgo(8) } });
    SUB[d.name] = r;
  }

  // ── reddit accounts ──
  const acctDefs = [
    {
      key: 'jane',
      username: 'jane_from_acme',
      redditId: 't2_8jq3n',
      roleLabel: 'founder',
      disclosureLine: 'I work on Acme',
      karma: 2410,
      created: dAgo(365 * 3 + 60),
      limit: 5,
      promoMax: 10,
      health: 'healthy',
    },
    {
      key: 'leo',
      username: 'leo_acme_founder',
      redditId: 't2_4kd91',
      roleLabel: 'founder',
      disclosureLine: 'Co-founder at Acme',
      karma: 1180,
      created: dAgo(365 + 240),
      limit: 3,
      promoMax: 10,
      health: 'watch',
    },
    {
      key: 'sam',
      username: 'sam_acme_support',
      redditId: 't2_9xx20',
      roleLabel: 'support',
      disclosureLine: 'Support at Acme',
      karma: 640,
      created: dAgo(330),
      limit: 3,
      promoMax: 10,
      health: 'healthy',
    },
  ] as const;
  const ACC: Record<string, Awaited<ReturnType<typeof prisma.redditAccount.create>>> = {};
  for (const a of acctDefs) {
    ACC[a.key] = await prisma.redditAccount.create({
      data: {
        ...W,
        username: a.username,
        redditId: a.redditId,
        ownerMemberId: M[a.key]!,
        roleLabel: a.roleLabel,
        disclosureLine: a.disclosureLine,
        oauthTokenEnc: enc(`seed-refresh-token-${a.key}`),
        scopes: ['identity', 'read', 'submit', 'privatemessages', 'history', 'edit'],
        karma: a.karma,
        accountCreatedAt: a.created,
        dailyPostLimit: a.limit,
        selfPromoMax: a.promoMax,
        health: a.health,
      },
    });
  }
  // per-sub karma (Tracking › "Our karma")
  const subKarma: Record<string, number> = {
    projectmanagement: 2410,
    SaaS: 1180,
    startups: 640,
    productivity: 910,
    Entrepreneur: 120,
  };
  for (const [sub, karma] of Object.entries(subKarma)) {
    const acct =
      sub === 'SaaS' || sub === 'Entrepreneur' ? ACC.leo! : sub === 'startups' ? ACC.sam! : ACC.jane!;
    await prisma.accountSubredditStat.create({
      data: { ...W, accountId: acct.id, subredditId: SUB[sub]!.id, karma },
    });
  }

  // ── proxies and browser profiles ──
  const browserDefs = [
    {
      key: 'jane',
      name: 'Jane · Chrome',
      fp: {
        os: 'macOS 15',
        screen: '1512×982',
        tz: 'America/New_York',
        locale: 'en-US',
        ownerPlace: 'Boston, US',
      },
      proxy: {
        provider: 'Bright Data',
        label: 'us-ma-0417',
        kind: 'Residential',
        host: 'brd.superproxy.io',
        port: 22225,
        user: 'tl-acme-jane',
        sticky: true,
        region: 'Boston, US',
        test: {
          ip: '73.218.44.19',
          city: 'Boston, MA',
          country: 'US',
          timeZone: 'America/New_York',
          latencyMs: 142,
          redditOk: true,
          testedAt: minAgo(8),
        },
      },
      status: 'running',
      last: minAgo(14),
      since: dAgo(56),
    },
    {
      key: 'leo',
      name: 'Leo · Chrome',
      fp: {
        os: 'Windows 11',
        screen: '1920×1080',
        tz: 'Europe/Lisbon',
        locale: 'pt-PT, en',
        ownerPlace: 'Lisbon, PT',
      },
      proxy: {
        provider: 'Bright Data',
        label: 'pt-lis-0088',
        kind: 'Residential',
        host: 'brd.superproxy.io',
        port: 22225,
        user: 'tl-acme-leo',
        sticky: true,
        region: 'Lisbon, PT',
        test: {
          ip: '85.246.102.7',
          city: 'Lisbon, PT',
          country: 'PT',
          timeZone: 'Europe/Lisbon',
          latencyMs: 96,
          redditOk: true,
          testedAt: hAgo(1),
        },
      },
      status: 'running',
      last: minAgo(3),
      since: dAgo(36),
    },
    {
      key: 'sam',
      name: 'Sam · Chrome',
      fp: {
        os: 'macOS 14',
        screen: '1440×900',
        tz: 'America/Chicago',
        locale: 'en-US',
        ownerPlace: 'Austin, US',
      },
      proxy: {
        provider: 'Oxylabs',
        label: 'us-ny-0912',
        kind: 'Datacenter',
        host: 'proxy.oxylabs.io',
        port: 7777,
        user: 'tl-acme-sam',
        sticky: false,
        region: 'New York, US',
        test: {
          ip: '104.21.8.230',
          city: 'New York, NY',
          country: 'US',
          timeZone: 'America/New_York',
          latencyMs: 210,
          redditOk: true,
          testedAt: dAgo(2),
        },
      },
      status: 'check',
      last: dAgo(1),
      since: dAgo(18),
    },
  ] as const;
  const PROFILE: Record<string, string> = {};
  for (const b of browserDefs) {
    const proxy = await prisma.proxy.create({
      data: {
        ...W,
        provider: `${b.proxy.provider} · ${b.proxy.label}`,
        protocol: 'http',
        host: b.proxy.host,
        port: b.proxy.port,
        usernameEnc: enc(b.proxy.user),
        passwordEnc: enc(`seed-proxy-pass-${b.key}`),
        sticky: b.proxy.sticky,
        region: b.proxy.region,
        lastTest: {
          ...b.proxy.test,
          testedAt: b.proxy.test.testedAt.toISOString(),
          kind: b.proxy.kind,
          label: b.proxy.label,
          userHint: b.proxy.user,
        },
      },
    });
    const prof = await prisma.browserProfile.create({
      data: {
        ...W,
        accountId: ACC[b.key]!.id,
        name: b.name,
        status: b.status,
        proxyId: proxy.id,
        fingerprint: { ...b.fp, capturedAt: b.since.toISOString() },
        cookiesVolume: `tl-profile-${b.key}`,
        lastSessionAt: b.last,
        createdAt: b.since,
      },
    });
    PROFILE[b.key] = prof.id;
  }

  // ── agents ──
  const agentDefs = [
    {
      key: 'maya',
      name: 'Maya',
      roleTitle: 'Product Expert',
      focus: 'project-management subs',
      color: '#6D5BD0',
      acct: 'jane',
      approver: 'jane',
      status: 'active',
      persona: {
        focus: 'project-management subs',
        voice: { formal: 35, playful: 25, concise: 70, technical: 45 },
        dos: [
          'Answer the question before mentioning Acme',
          'Name the trade-offs honestly, including where Asana or ClickUp are better',
          'Disclose in the same paragraph as the first mention of Acme',
        ],
        donts: [
          'No pricing claims about competitors',
          'No “game-changer”, “revolutionary” or other hype words',
          'Never reply to threads older than 48 hours',
        ],
        disclosure: 'I work on Acme',
        samples: [
          'We hit the same wall at 6 people — Asana felt built for a 60-person org. Disclosure: I work on Acme, so I’m biased.',
        ],
      },
      skills: { compare_answer: true, launch_post: false, demo_followup: false, thread_to_blog: true },
      subs: ['projectmanagement', 'productivity', 'startups'],
    },
    {
      key: 'leo',
      name: 'Leo',
      roleTitle: 'Founder Voice',
      focus: 'launches and AMAs',
      color: '#0F766E',
      acct: 'leo',
      approver: 'jane',
      status: 'active',
      persona: {
        focus: 'launches and AMAs',
        voice: { formal: 25, playful: 45, concise: 50, technical: 60 },
        dos: ['Write in first person as a founder', 'Share what we learned, including mistakes'],
        donts: ['No links where the sub disallows them', 'No hype words'],
        disclosure: 'Co-founder at Acme',
        samples: ['Speed was the reason we left ClickUp too. Two things helped…'],
      },
      skills: { compare_answer: true, launch_post: true, demo_followup: false, thread_to_blog: false },
      subs: ['SaaS', 'Entrepreneur'],
    },
    {
      key: 'sam',
      name: 'Sam',
      roleTitle: 'Support Follow-ups',
      focus: 'DMs after engagement',
      color: '#475569',
      acct: 'sam',
      approver: 'jane',
      status: 'paused',
      persona: {
        focus: 'DMs after engagement',
        voice: { formal: 50, playful: 15, concise: 80, technical: 55 },
        dos: ['Answer the exact question asked', 'Link to docs, not to pricing'],
        donts: ['Never DM someone who has not messaged or replied to us first', 'No discount offers'],
        disclosure: 'Support at Acme',
        samples: ['Yes — guests are free and can only see boards you share with them.'],
      },
      skills: { compare_answer: false, launch_post: false, demo_followup: true, thread_to_blog: false },
      subs: [],
    },
  ] as const;
  const AG: Record<string, string> = {};
  for (const a of agentDefs) {
    const ag = await prisma.agent.create({
      data: {
        ...W,
        name: a.name,
        roleTitle: a.roleTitle,
        status: a.status,
        accountId: ACC[a.acct]!.id,
        approverMemberId: M[a.approver]!,
        persona: { ...a.persona, subreddits: [...a.subs] },
        dailyDraftLimit: 20,
        color: a.color,
      },
    });
    AG[a.key] = ag.id;
    for (const [key, enabled] of Object.entries(a.skills))
      await prisma.agentSkill.create({ data: { ...W, agentId: ag.id, key: key as never, enabled } });
    for (const provider of [
      'notion',
      'gdrive',
      'hubspot',
      'attio',
      'slack',
      'ga4',
      'posthog',
      'stripe',
      'calendly',
    ] as const) {
      const v1 = provider === 'notion' || provider === 'gdrive' || provider === 'hubspot';
      const connected =
        (a.key === 'maya' && (provider === 'notion' || provider === 'hubspot')) ||
        (a.key === 'sam' && provider === 'hubspot');
      await prisma.connector.create({
        data: {
          ...W,
          agentId: ag.id,
          provider,
          status: v1 ? (connected ? 'connected' : 'disconnected') : 'coming_soon',
          permissions: connected
            ? { tools: provider === 'notion' ? ['search', 'read_page'] : ['read_contact', 'upsert_contact'] }
            : {},
        },
      });
    }
  }
  const contextDefs = [
    {
      agent: 'maya',
      kind: 'url',
      title: 'Acme vs Asana — small team comparison',
      sourceUrl: 'https://acme.so/compare/asana',
      content: 'One board per project, free guests, flat price up to 10 users.',
      fresh: dAgo(2),
    },
    {
      agent: 'maya',
      kind: 'pricing',
      title: 'Pricing page',
      sourceUrl: 'https://acme.so/pricing',
      content: 'Team plan $8/user/month, guests free, annual discount 20%.',
      fresh: dAgo(1),
    },
    {
      agent: 'maya',
      kind: 'doc',
      title: 'Guest access (Notion)',
      sourceUrl: 'https://notion.so/acme/guest-access',
      content: 'Guests are free and can only see boards shared with them.',
      fresh: dAgo(5),
    },
    {
      agent: 'maya',
      kind: 'faq',
      title: 'Import from Trello and Asana',
      sourceUrl: 'https://acme.so/docs/import',
      content: 'CSV and API import; due dates map to date fields.',
      fresh: dAgo(12),
    },
    {
      agent: 'maya',
      kind: 'approved_reply',
      title: '24 approved replies',
      sourceUrl: null,
      content: 'Approved reply corpus.',
      fresh: hAgo(3),
    },
    {
      agent: 'leo',
      kind: 'doc',
      title: 'Founder story and launch notes',
      sourceUrl: 'https://notion.so/acme/launch',
      content: 'Why we built Acme for teams under 10.',
      fresh: dAgo(9),
    },
    {
      agent: 'sam',
      kind: 'faq',
      title: 'Support macros',
      sourceUrl: 'https://acme.so/docs',
      content: 'Common support answers.',
      fresh: dAgo(4),
    },
  ] as const;
  for (const c of contextDefs)
    await prisma.contextItem.create({
      data: {
        ...W,
        agentId: AG[c.agent]!,
        kind: c.kind,
        title: c.title,
        sourceUrl: c.sourceUrl,
        content: c.content,
        freshAt: c.fresh,
      },
    });

  // ── keyword groups ──
  const groupDefs = [
    {
      key: 'asana',
      name: 'Asana alternative',
      intent: 'looking_for_tool',
      include: ['asana alternative', 'leaving asana', 'asana too expensive'],
      competitor: ['asana'],
      exclude: ['asana jobs'],
      alert: { channel: 'slack', target: '#reddit', cadence: 'instant' },
      agent: 'maya',
      subs: ['projectmanagement', 'productivity', 'startups'],
    },
    {
      key: 'clickup',
      name: 'ClickUp complaints',
      intent: 'competitor_complaint',
      include: ['clickup slow', 'clickup bloated', 'moving off clickup'],
      competitor: ['clickup'],
      exclude: ['clickup api'],
      alert: { channel: 'slack', target: '#reddit', cadence: 'instant' },
      agent: 'leo',
      subs: ['SaaS', 'projectmanagement'],
    },
    {
      key: 'smallteam',
      name: 'Small-team PM tools',
      intent: 'recommendation',
      include: ['pm tool for small team', 'project management under 10', 'simple task tracker team'],
      competitor: [],
      exclude: ['enterprise'],
      alert: { channel: 'email', target: 'jane@acme.so', cadence: 'daily' },
      agent: 'maya',
      subs: ['startups', 'productivity', 'Entrepreneur'],
    },
    {
      key: 'guests',
      name: 'Guest access',
      intent: 'discussion',
      include: ['client guest access', 'free guests'],
      competitor: ['notion'],
      exclude: [],
      alert: { channel: 'none', cadence: 'off' },
      agent: 'sam',
      subs: ['projectmanagement', 'Entrepreneur'],
    },
  ] as const;
  const KG: Record<string, string> = {};
  for (const g of groupDefs) {
    const kg = await prisma.keywordGroup.create({
      data: {
        ...W,
        name: g.name,
        intent: g.intent,
        include: [...g.include],
        exclude: [...g.exclude],
        competitor: [...g.competitor],
        alert: g.alert,
        agentId: AG[g.agent]!,
        subreddits: [...g.subs],
      },
    });
    KG[g.key] = kg.id;
  }

  // ── posts + opportunities (5 featured + 33 more = 38 today) ──
  type Opp = {
    sub: string;
    score: number;
    status: string;
    title: string;
    body: string;
    kw: string;
    author: string;
    up: number;
    com: number;
    ageH: number;
    intent: string;
    why: string;
    group: string;
    agent: string;
    competitors: string[];
    top?: { author: string; body: string; score: number }[];
  };
  const featured: Opp[] = [
    {
      sub: 'projectmanagement',
      score: 94,
      status: 'new',
      title: 'Looking for a simple Asana alternative for a 6-person team',
      body: 'We’re a 6-person agency and Asana pricing jumped when we added two contractors. Need boards, due dates and client guest access. Budget is maybe $50/mo total. Tried ClickUp — too much. What are small teams actually using?',
      kw: 'Asana pricing',
      author: 'ops_tom',
      up: 42,
      com: 31,
      ageH: 3,
      intent: 'looking_for_tool',
      why: 'Asks for an Asana alternative for a team under 10 with a stated budget and three concrete needs.',
      group: 'asana',
      agent: 'maya',
      competitors: ['Asana · pricing', 'ClickUp · bloat'],
      top: [
        {
          author: 'pm_lena',
          body: 'We moved to Linear but it’s dev-first. For an agency I’d look at something lighter.',
          score: 18,
        },
        {
          author: 'agency_ines',
          body: 'Guest access is the dealbreaker for us too. Most tools charge per guest.',
          score: 11,
        },
      ],
    },
    {
      sub: 'SaaS',
      score: 91,
      status: 'drafting',
      title: 'ClickUp is getting too bloated for us — what are you moving to?',
      body: 'Every release adds a view nobody asked for. Looking for a ClickUp alternative that stays fast for a 12-person team?',
      kw: 'ClickUp alternative',
      author: 'bootstrapped_ben',
      up: 118,
      com: 64,
      ageH: 5,
      intent: 'competitor_complaint',
      why: 'Complains about ClickUp speed and bloat; team size fits our ICP. No links allowed — Leo will answer without one.',
      group: 'clickup',
      agent: 'leo',
      competitors: ['ClickUp · speed'],
      top: [{ author: 'tara_ships', body: 'Same. We tried three tools this year.', score: 22 }],
    },
    {
      sub: 'startups',
      score: 87,
      status: 'drafting',
      title: 'What do you use to run sprints with a remote team of 8?',
      body: 'We tried Jira and it’s overkill. Looking for sprint planning that doesn’t need a Jira admin.',
      kw: 'sprint planning',
      author: 'remote_raj',
      up: 27,
      com: 19,
      ageH: 2,
      intent: 'recommendation',
      why: 'Open recommendation request; rejects Jira as too heavy. Today is Saturday, so a disclosed answer is within sub rules.',
      group: 'smallteam',
      agent: 'maya',
      competitors: ['Jira · complexity'],
      top: [
        {
          author: 'devon_builds',
          body: 'Linear if you are all engineers, otherwise something lighter.',
          score: 9,
        },
      ],
    },
    {
      sub: 'productivity',
      score: 72,
      status: 'drafting',
      title: 'Notion for task tracking feels like overkill. Lighter options?',
      body: 'I love Notion for docs but task tracking in databases is slow and my team ignores it.',
      kw: 'task tracking',
      author: 'quiet_lists',
      up: 63,
      com: 40,
      ageH: 7,
      intent: 'looking_for_tool',
      why: 'Wants a lighter tasks layer next to Notion docs; mixed personal/team use so score is medium.',
      group: 'asana',
      agent: 'maya',
      competitors: ['Notion · speed'],
    },
    {
      sub: 'Entrepreneur',
      score: 64,
      status: 'skipped',
      title: 'How do you keep client projects from slipping through the cracks?',
      body: 'Three clients, missed deadlines twice this month. Is it a tool problem or a me problem?',
      kw: 'missed deadlines',
      author: 'agency_ines',
      up: 15,
      com: 22,
      ageH: 9,
      intent: 'discussion',
      why: 'Discussion about process more than tools; sub bans self-promo, so advice-only reply if any.',
      group: 'guests',
      agent: 'leo',
      competitors: [],
    },
  ];
  const fillerTitles = [
    [
      'projectmanagement',
      'Best way to share project boards with clients without paying per seat?',
      'client guest access',
      'guests',
      'looking_for_tool',
    ],
    [
      'SaaS',
      'Moving off ClickUp after 3 years — what did you switch to?',
      'moving off clickup',
      'clickup',
      'competitor_complaint',
    ],
    [
      'startups',
      'Simple task tracker for a 4-person founding team?',
      'simple task tracker team',
      'smallteam',
      'recommendation',
    ],
    [
      'productivity',
      'Asana too expensive for a tiny team — alternatives?',
      'asana too expensive',
      'asana',
      'looking_for_tool',
    ],
    [
      'projectmanagement',
      'Is there a PM tool for small teams that isn’t built for enterprises?',
      'pm tool for small team',
      'smallteam',
      'recommendation',
    ],
    ['SaaS', 'ClickUp slow on big boards, anyone else?', 'clickup slow', 'clickup', 'competitor_complaint'],
    [
      'Entrepreneur',
      'Project management under 10 people — what actually works?',
      'project management under 10',
      'smallteam',
      'discussion',
    ],
    [
      'projectmanagement',
      'Leaving Asana: how did you migrate your projects?',
      'leaving asana',
      'asana',
      'looking_for_tool',
    ],
    [
      'startups',
      'Tool to track client deliverables for a small agency?',
      'client guest access',
      'guests',
      'recommendation',
    ],
    [
      'productivity',
      'Kanban app that my non-technical team will actually use',
      'simple task tracker team',
      'smallteam',
      'looking_for_tool',
    ],
    ['SaaS', 'ClickUp bloated — is it just us?', 'clickup bloated', 'clickup', 'competitor_complaint'],
  ] as const;
  const fillerAuthors = [
    'kito_pm',
    'solo_sana',
    'tara_ships',
    'mkt_rhea',
    'fernhill_ops',
    'devon_builds',
    'pm_lena',
    'ops_kat',
    'lean_lucas',
    'nadia_ops',
    'growth_gus',
    'teamlead_tess',
    'sprint_sol',
    'agency_amir',
  ];
  const all: Opp[] = [...featured];
  for (let i = 0; i < 33; i++) {
    const [sub, title, kw, group, intent] = fillerTitles[i % fillerTitles.length]!;
    const score = 60 + Math.floor(rnd() * 26);
    all.push({
      sub,
      score,
      title: i < fillerTitles.length ? title : `${title} (${Math.floor(i / fillerTitles.length) + 1})`,
      body: `Context: small team, budget matters. We have looked at a few tools for ${kw} but nothing fits yet.`,
      kw,
      author: fillerAuthors[i % fillerAuthors.length]!,
      up: 5 + Math.floor(rnd() * 90),
      com: 2 + Math.floor(rnd() * 50),
      ageH: 1 + Math.floor(rnd() * 22),
      intent,
      why: `Matches “${kw}” with ${score >= 80 ? 'a clear' : 'some'} buying signal; team size unclear.`,
      group,
      agent: group === 'clickup' ? 'leo' : group === 'guests' ? 'sam' : 'maya',
      competitors: [],
      status: i % 7 === 3 ? 'watched' : i % 9 === 5 ? 'skipped' : 'new',
    });
  }
  const POST: Record<string, string> = {};
  const OPP: Record<string, string> = {};
  for (const [i, o] of all.entries()) {
    const redditId = i === 0 ? 't3_1h8k2q' : `t3_${(1_700_000 + i * 7919).toString(36)}`;
    const post = await prisma.post.create({
      data: {
        ...W,
        redditId,
        subredditId: SUB[o.sub]!.id,
        authorUsername: o.author,
        title: o.title,
        body: o.body,
        url: `https://www.reddit.com/r/${o.sub}/comments/${redditId.slice(3)}/`,
        upvotes: o.up,
        comments: o.com,
        topComments: o.top ?? [],
        postedAt: hAgo(o.ageH),
        fetchedAt: hAgo(Math.max(0, o.ageH - 0.2)),
      },
    });
    const opp = await prisma.opportunity.create({
      data: {
        ...W,
        postId: post.id,
        keywordGroupId: KG[o.group]!,
        score: o.score,
        level: o.score >= 80 ? 'high' : o.score >= 60 ? 'medium' : 'low',
        intent: o.intent as never,
        reason: o.why,
        competitorMentions: o.competitors,
        matchedKeyword: o.kw,
        status: o.status as never,
        suggestedAgentId: AG[o.agent]!,
        createdAt: hAgo(Math.max(0, o.ageH - 0.25)),
      },
    });
    POST[redditId] = post.id;
    if (i < 5) OPP[`f${i + 1}`] = opp.id;
  }
  // older posts that leads came from
  const oldThreads = [
    ['SaaS', 'Per-seat pricing is killing us', 'tara_ships', 4],
    ['projectmanagement', 'Trello is fine until it isn’t', 'devon_builds', 6],
    ['startups', 'Best tool for a 5-person marketing team?', 'mkt_rhea', 5],
    ['SaaS', 'Moving off Asana — lessons?', 'fernhill_ops', 12],
    ['projectmanagement', 'Guest access in PM tools', 'kito_pm', 15],
    ['productivity', 'Free alternatives to Notion?', 'solo_sana', 13],
  ] as const;
  for (const [i, [sub, title, author, d]] of oldThreads.entries()) {
    const redditId = `t3_old${i}`;
    const p = await prisma.post.create({
      data: {
        ...W,
        redditId,
        subredditId: SUB[sub]!.id,
        authorUsername: author,
        title,
        body: '',
        url: `https://www.reddit.com/r/${sub}/comments/old${i}/`,
        upvotes: 20 + i * 7,
        comments: 10 + i * 3,
        postedAt: dAgo(d),
        fetchedAt: dAgo(d),
      },
    });
    POST[title] = p.id;
  }

  // ── tracked links ──
  const linkDefs = [
    {
      slug: 'pm6tea',
      label: 'pm-6team',
      dest: 'https://acme.so/compare/asana',
      medium: 'comment',
      sub: 'projectmanagement',
      agent: 'maya',
      post: 't3_1h8k2q',
      clicks: 612,
      conv: 31,
    },
    {
      slug: 'clkspd',
      label: 'clickup-speed',
      dest: 'https://acme.so/compare/clickup',
      medium: 'comment',
      sub: 'SaaS',
      agent: 'leo',
      post: null,
      clicks: 488,
      conv: 24,
    },
    {
      slug: 'lnchsa',
      label: 'launch-saas',
      dest: 'https://acme.so/launch',
      medium: 'post',
      sub: 'SaaS',
      agent: 'leo',
      post: null,
      clicks: 374,
      conv: 19,
    },
    {
      slug: 'guests',
      label: 'guests',
      dest: 'https://acme.so/docs/guest-access',
      medium: 'dm',
      sub: null,
      agent: 'sam',
      post: null,
      clicks: 142,
      conv: 11,
    },
    {
      slug: 'sprnt8',
      label: 'sprints-8',
      dest: 'https://acme.so/templates/sprints',
      medium: 'comment',
      sub: 'startups',
      agent: 'maya',
      post: null,
      clicks: 97,
      conv: 4,
    },
  ] as const;
  const LINK: Record<string, string> = {};
  for (const l of linkDefs) {
    const utm = buildUtm({ medium: l.medium, subreddit: l.sub, postId: l.post, agent: l.agent });
    const tl = await prisma.trackedLink.create({
      data: {
        ...W,
        slug: l.slug,
        destinationUrl: l.dest,
        medium: l.medium,
        subredditId: l.sub ? SUB[l.sub]!.id : null,
        postId: l.post ? POST[l.post]! : null,
        agentId: AG[l.agent]!,
        utm: { ...utm, label: l.label, full: withUtm(l.dest, utm) },
        clicks: l.clicks,
        createdAt: dAgo(20),
      },
    });
    LINK[l.label] = tl.id;
    // click events spread over 30 days, weighted to recent
    const rows = Array.from({ length: l.clicks }, (_, i) => {
      const daysBack = Math.floor(rnd() ** 1.6 * 30);
      return {
        ...W,
        trackedLinkId: tl.id,
        visitorId: `v_${l.slug}_${i % Math.max(1, Math.floor(l.clicks * 0.65))}`,
        ipHash: null,
        ua: 'seed',
        referer: 'https://www.reddit.com/',
        occurredAt: new Date(dAgo(daysBack).getTime() - rnd() * 86_400_000),
      };
    });
    await prisma.clickEvent.createMany({ data: rows });
    // signups from a share of visitors
    const signups = Array.from({ length: l.conv }, (_, i) => ({
      ...W,
      visitorId: `v_${l.slug}_${i}`,
      kind: 'signup' as const,
      email: null,
      occurredAt: dAgo(Math.floor(rnd() * 25)),
    }));
    await prisma.siteEvent.createMany({ data: signups });
  }

  // ── reddit users + leads ──
  type L = [
    string,
    string,
    number,
    number,
    string,
    number,
    string,
    string,
    string,
    number,
    string,
    number,
    string,
  ];
  // [username, sub, score, lastActivityMinutesAgo, owner, dealCents, stage, thread, agent, clicks, email, revenueCents, tags]
  const leadDefs: L[] = [
    [
      'quiet_lists',
      'productivity',
      58,
      2 * 1440,
      'jane',
      0,
      'new',
      'Notion for task tracking feels like overkill. Lighter options?',
      'maya',
      0,
      '',
      0,
      'notion',
    ],
    [
      'pm_lena',
      'projectmanagement',
      52,
      3 * 1440,
      'sam',
      0,
      'new',
      'Looking for a simple Asana alternative for a 6-person team',
      'maya',
      0,
      '',
      0,
      '',
    ],
    [
      'remote_raj',
      'startups',
      87,
      60,
      'jane',
      0,
      'engaged',
      'What do you use to run sprints with a remote team of 8?',
      'maya',
      2,
      '',
      0,
      'remote',
    ],
    [
      'agency_ines',
      'Entrepreneur',
      70,
      300,
      'leo',
      0,
      'engaged',
      'How do you keep client projects from slipping through the cracks?',
      'leo',
      1,
      '',
      0,
      'agency',
    ],
    [
      'bootstrapped_ben',
      'SaaS',
      91,
      26,
      'leo',
      18000,
      'replied',
      'ClickUp is getting too bloated for us — what are you moving to?',
      'leo',
      3,
      '',
      0,
      'clickup',
    ],
    [
      'ops_kat',
      'projectmanagement',
      88,
      10,
      'jane',
      4900,
      'interested',
      'Looking for a simple Asana alternative for a 6-person team',
      'sam',
      4,
      '',
      0,
      'agency, asana',
    ],
    [
      'tara_ships',
      'SaaS',
      79,
      1440,
      'leo',
      9800,
      'interested',
      'Per-seat pricing is killing us',
      'leo',
      2,
      '',
      0,
      '',
    ],
    [
      'devon_builds',
      'projectmanagement',
      84,
      60,
      'sam',
      14700,
      'trial',
      'Trello is fine until it isn’t',
      'sam',
      6,
      'devon@tinyhq.co',
      0,
      'trial',
    ],
    [
      'mkt_rhea',
      'startups',
      81,
      180,
      'jane',
      9800,
      'trial',
      'Best tool for a 5-person marketing team?',
      'maya',
      5,
      'rhea@brightloop.io',
      0,
      'trial',
    ],
    [
      'fernhill_ops',
      'SaaS',
      90,
      5 * 1440,
      'leo',
      49000,
      'customer',
      'Moving off Asana — lessons?',
      'leo',
      9,
      'ops@fernhill.io',
      49000,
      'annual',
    ],
    [
      'kito_pm',
      'projectmanagement',
      76,
      9 * 1440,
      'jane',
      14700,
      'customer',
      'Guest access in PM tools',
      'maya',
      4,
      'kito@studiokito.com',
      14700,
      '',
    ],
    [
      'solo_sana',
      'productivity',
      40,
      11 * 1440,
      'sam',
      0,
      'lost',
      'Free alternatives to Notion?',
      'maya',
      1,
      '',
      0,
      'price',
    ],
  ];
  const postByTitle = async (title: string) =>
    (await prisma.post.findFirst({ where: { ...W, title } }))?.id ?? null;
  const LEAD: Record<string, string> = {};
  for (const [i, l] of leadDefs.entries()) {
    const [username, , score, lastMin, owner, deal, stage, thread, agent, , email, rev, tags] = l;
    const firstSeen = await postByTitle(thread);
    const ru = await prisma.redditUser.create({
      data: { ...W, username, redditId: `t2_seed${i}`, firstSeenPostId: firstSeen },
    });
    const lead = await prisma.lead.create({
      data: {
        ...W,
        redditUserId: ru.id,
        stage: stage as never,
        intentScore: score,
        ownerMemberId: M[owner]!,
        agentId: AG[agent]!,
        dealValueCents: deal,
        signupEmail: email || null,
        revenueCents: rev,
        tags: tags ? tags.split(', ') : [],
        notes:
          username === 'ops_kat'
            ? [
                {
                  by: 'Jane Park',
                  at: hAgo(20).toISOString(),
                  body: 'Agency with ~40 Trello boards. Guest access is the deciding feature. Send import doc.',
                },
              ]
            : [],
        hubspotId: ['fernhill_ops', 'kito_pm', 'ops_kat', 'devon_builds', 'mkt_rhea'].includes(username)
          ? `hs_${1000 + i}`
          : null,
        hubspotSyncedAt: ['fernhill_ops', 'kito_pm', 'ops_kat', 'devon_builds', 'mkt_rhea'].includes(username)
          ? minAgo(4)
          : null,
        lastActivityAt: minAgo(lastMin),
        createdAt: minAgo(lastMin + 2 * 1440),
      },
    });
    LEAD[username] = lead.id;
  }
  await prisma.leadTask.createMany({
    data: [
      { ...W, leadId: LEAD.ops_kat!, title: 'Send Trello import guide', dueAt: hAgo(-20), done: false },
      {
        ...W,
        leadId: LEAD.ops_kat!,
        title: 'Offer a 20-minute walkthrough if she asks',
        dueAt: hAgo(-68),
        done: false,
      },
      {
        ...W,
        leadId: LEAD.ops_kat!,
        title: 'Confirm guest pricing answer with Leo',
        dueAt: dAgo(1),
        done: true,
      },
      { ...W, leadId: LEAD.devon_builds!, title: 'Check due-date import bug', dueAt: hAgo(-4), done: false },
    ],
  });

  // ── historical posted drafts (back the account meters: today count + 7-day self-promo ratio) ──
  // jane: 11 items in 7 days, 1 promotional, 3 today; leo: 8 items, 1 promo (but a recent launch) , 2 today; sam: 4 items, 0 promo, 1 today
  const history: Record<string, { total: number; promo: number; today: number; agent: string; sub: string }> =
    {
      jane: { total: 11, promo: 1, today: 3, agent: 'maya', sub: 'projectmanagement' },
      leo: { total: 8, promo: 1, today: 2, agent: 'leo', sub: 'SaaS' },
      sam: { total: 4, promo: 0, today: 1, agent: 'sam', sub: 'projectmanagement' },
    };
  const POSTED: Record<string, string[]> = { jane: [], leo: [], sam: [] };
  for (const [acct, h] of Object.entries(history)) {
    for (let i = 0; i < h.total; i++) {
      const when = i < h.today ? minAgo(30 + i * 90) : dAgo(1 + ((i - h.today) % 6));
      const d = await prisma.draft.create({
        data: {
          ...W,
          agentId: AG[h.agent]!,
          accountId: ACC[acct]!.id,
          type: acct === 'sam' ? 'dm' : 'comment',
          body: `Helpful answer #${i + 1}. ${ACC[acct]!.disclosureLine}.`,
          status: 'posted',
          approverMemberId: M.jane!,
          approvedAt: new Date(when.getTime() - 600_000),
          postedAt: when,
          postedRedditId: `t1_hist${acct}${i}`,
          promotional: i < h.promo,
          createdAt: new Date(when.getTime() - 3_600_000),
        },
      });
      POSTED[acct]!.push(d.id);
    }
  }

  // ── conversations + messages ──
  const convDefs = [
    {
      user: 'ops_kat',
      kind: 'dm',
      t: 26,
      unread: true,
      needsReply: true,
      where: 'Replied to our comment in r/projectmanagement',
      post: 't3_1h8k2q',
      msgs: [
        {
          dir: 'out',
          acct: 'jane',
          author: 'jane_from_acme',
          body: 'We hit the same wall at 6 people — Asana felt built for a 60-person org. What mattered for us: one board per project, free guests for clients, and no per-seat jump past 5 users. Disclosure: I work on Acme, so I’m biased.',
          at: dAgo(2),
        },
        {
          dir: 'in',
          author: 'ops_kat',
          body: 'This is exactly our setup. Does it support guest access for clients, or is that a paid add-on?',
          at: dAgo(1.1),
        },
        {
          dir: 'out',
          acct: 'sam',
          author: 'sam_acme_support',
          body: 'Yes — guests are free and can only see boards you share with them. Support at Acme here — happy to send the docs.',
          at: hAgo(1),
        },
        {
          dir: 'in',
          author: 'ops_kat',
          body: 'Please do. Also, is there a Trello import? We have ~40 boards.',
          at: minAgo(26),
        },
      ],
    },
    {
      user: 'bootstrapped_ben',
      kind: 'comment_thread',
      t: 60,
      unread: true,
      needsReply: true,
      where: 'r/SaaS · thread with Leo',
      post: 'ClickUp is getting too bloated for us — what are you moving to?',
      msgs: [
        {
          dir: 'out',
          acct: 'leo',
          author: 'leo_acme_founder',
          body: 'Speed was the reason we left ClickUp too. Co-founder at Acme, so grain of salt — but two things helped: fewer views, and archiving done boards.',
          at: hAgo(3),
        },
        {
          dir: 'in',
          author: 'bootstrapped_ben',
          body: 'Fair. How does it handle 12 people on one board without turning into a wall of cards?',
          at: minAgo(60),
        },
      ],
    },
    {
      user: 'devon_builds',
      kind: 'dm',
      t: 180,
      unread: true,
      needsReply: true,
      where: 'Started a trial from r/projectmanagement',
      post: null,
      msgs: [
        {
          dir: 'in',
          author: 'devon_builds',
          body: 'Hey, saw your comment. Trying the trial now.',
          at: dAgo(2),
        },
        {
          dir: 'out',
          acct: 'sam',
          author: 'sam_acme_support',
          body: 'Welcome! Support at Acme — ping me if anything is unclear.',
          at: dAgo(1.9),
        },
        {
          dir: 'in',
          author: 'devon_builds',
          body: 'Import worked, but due dates came in as text. Known issue?',
          at: minAgo(180),
        },
      ],
    },
    {
      user: 'mkt_rhea',
      kind: 'comment_thread',
      t: 300,
      unread: false,
      needsReply: false,
      where: 'r/startups · thread with Maya',
      post: 'Best tool for a 5-person marketing team?',
      msgs: [
        {
          dir: 'out',
          acct: 'jane',
          author: 'jane_from_acme',
          body: 'For five people I’d keep one board per campaign. I work on Acme, which does this well, but Trello works too.',
          at: hAgo(8),
        },
        {
          dir: 'in',
          author: 'mkt_rhea',
          body: 'Thanks! Signed up to try it with the team this week.',
          at: minAgo(300),
        },
      ],
    },
    {
      user: 'remote_raj',
      kind: 'comment_thread',
      t: 1440,
      unread: false,
      needsReply: false,
      where: 'r/startups · thread with Maya',
      post: 'What do you use to run sprints with a remote team of 8?',
      msgs: [
        {
          dir: 'out',
          acct: 'jane',
          author: 'jane_from_acme',
          body: 'Jira is great at scale but heavy for 8. I work on Acme — we keep sprints to one board per squad.',
          at: dAgo(1.2),
        },
        {
          dir: 'in',
          author: 'remote_raj',
          body: 'Appreciate the honest take on Jira. Will look.',
          at: dAgo(1),
        },
      ],
    },
    {
      user: 'fernhill_ops',
      kind: 'dm',
      t: 2880,
      unread: false,
      needsReply: false,
      where: 'Customer · replied to Leo in r/SaaS',
      post: null,
      msgs: [
        {
          dir: 'in',
          author: 'fernhill_ops',
          body: 'We went annual. Can you add two more seats to the invoice?',
          at: dAgo(2),
        },
      ],
    },
    {
      user: 'pm_lena',
      kind: 'comment_thread',
      t: 4320,
      unread: false,
      needsReply: false,
      where: 'r/projectmanagement · thread with Maya',
      post: 't3_1h8k2q',
      msgs: [{ dir: 'in', author: 'pm_lena', body: 'Not for us right now, but bookmarking.', at: dAgo(3) }],
    },
  ] as const;
  const CONV: Record<string, string> = {};
  for (const c of convDefs) {
    const postId = c.post ? (c.post.startsWith('t3_') ? POST[c.post]! : await postByTitle(c.post)) : null;
    const conv = await prisma.conversation.create({
      data: {
        ...W,
        leadId: LEAD[c.user]!,
        kind: c.kind,
        postId,
        lastMessageAt: minAgo(c.t),
        unread: c.unread,
        needsReply: c.needsReply,
        originReason: c.where,
      },
    });
    CONV[c.user] = conv.id;
    for (const [i, m] of c.msgs.entries()) {
      const isOut = m.dir === 'out';
      const acct = isOut ? ACC[(m as { acct: string }).acct]! : null;
      const draftId = isOut ? (POSTED[(m as { acct: string }).acct]!.shift() ?? null) : null;
      await prisma.message.create({
        data: {
          ...W,
          conversationId: conv.id,
          direction: m.dir,
          accountId: acct?.id ?? null,
          draftId,
          redditId: `t1_${c.user}_${i}`,
          author: m.author,
          body: m.body,
          sentAt: m.at,
        },
      });
    }
  }

  // ── pending drafts (the approval queue) ──
  const draftDefs = [
    {
      agent: 'maya',
      acct: 'jane',
      type: 'comment',
      opp: 'f1',
      wait: 41,
      sub: 'projectmanagement',
      post: 't3_1h8k2q',
      link: 'pm-6team',
      promo: true,
      body: 'We hit the same wall at 6 people — Asana felt built for a 60-person org. What mattered for us: one board per project instead of nested workspaces, free guests for clients, and no per-seat jump past 5 users.\nDisclosure: I work on Acme, so I’m biased. Here’s an honest comparison against Asana and ClickUp for small teams: acme.so/r/pm-6team\nHappy to answer anything, even if you end up going with something else.',
      reasoning:
        'OP named three needs (boards, due dates, guests) and a budget. I answered those first, disclosed up front, and linked the small-team comparison because the sub allows one relevant link. I avoided pricing claims about Asana.',
    },
    {
      agent: 'leo',
      acct: 'leo',
      type: 'post',
      opp: null,
      wait: 180,
      sub: 'SaaS',
      post: null,
      link: null,
      promo: true,
      title: 'We rebuilt our PM tool around teams under 10. Ask me anything',
      body: 'We rebuilt our PM tool around teams under 10. Ask me anything.\nCo-founder at Acme here. Two years ago we were a 6-person team drowning in Asana views. We cut everything that a team under 10 does not need: nested workspaces, per-guest pricing, 14 view types.\nWhat we got wrong: we shipped without an import and lost our first 30 trials. Happy to share numbers and mistakes.',
      reasoning:
        'Launch post for r/SaaS. The sub bans links in comments; this post carries no link. Leads with lessons, not features.',
    },
    {
      agent: 'leo',
      acct: 'leo',
      type: 'comment',
      opp: 'f2',
      wait: 60,
      sub: 'SaaS',
      post: null,
      link: null,
      promo: true,
      body: 'Speed was the reason we left ClickUp too. Two things helped: fewer views per board, and archiving finished boards weekly so search stays fast. Co-founder at Acme, so I’m biased — happy to share what we measured.',
      reasoning:
        'Complaint about ClickUp speed. r/SaaS allows no links in comments, so no link. Offered concrete advice first.',
    },
    {
      agent: 'sam',
      acct: 'sam',
      type: 'dm',
      conv: 'ops_kat',
      wait: 26,
      sub: null,
      post: null,
      link: 'guests',
      promo: false,
      body: 'Yes — guests are free and can only see shared boards. For Trello, there’s a one-click import that keeps lists and due dates: acme.so/r/guests. Happy to help if anything comes through oddly.',
      reasoning:
        'u/ops_kat asked two direct questions in DM. Answered both; disclosure was given in our first DM so it is not repeated.',
    },
    {
      agent: 'maya',
      acct: 'jane',
      type: 'comment',
      opp: 'f3',
      wait: 18,
      sub: 'startups',
      post: null,
      link: null,
      promo: true,
      body: 'For 8 people I’d keep it to one board per squad and a single sprint view across them. Jira is great at scale but the admin overhead is real at your size. I work on Acme, which is built for exactly this, but Linear is also worth a look if you’re all engineers.',
      reasoning:
        'Recommendation request; today is Saturday so r/startups allows a disclosed answer. No link used.',
    },
    {
      agent: 'maya',
      acct: 'jane',
      type: 'comment',
      opp: 'f4',
      wait: 120,
      sub: 'productivity',
      post: null,
      link: null,
      promo: true,
      body: 'If you love Notion docs, keep them — move just the tasks into something with real due dates and a board. Disclosure: I work on Acme; we link tasks back to Notion pages so nothing gets duplicated.',
      reasoning: 'OP wants to keep Notion for docs. Suggested a split rather than a full switch.',
    },
    {
      agent: 'sam',
      acct: 'sam',
      type: 'dm',
      conv: 'devon_builds',
      wait: 9,
      sub: null,
      post: null,
      link: null,
      promo: false,
      body: 'Thanks for trying the trial! The import from Trello maps due dates when they’re set as Trello due dates; custom-field dates come in as text. I can convert them for you in one go — want me to?',
      reasoning: 'u/devon_builds reported an import issue. Explained the cause and offered to fix it.',
    },
  ] as const;

  const promoStats = async (accountId: string) => {
    const since = dAgo(7);
    const startOfDay = new Date(NOW);
    startOfDay.setHours(0, 0, 0, 0);
    const [total, promo, today] = await Promise.all([
      prisma.draft.count({ where: { accountId, status: 'posted', postedAt: { gte: since } } }),
      prisma.draft.count({
        where: { accountId, status: 'posted', postedAt: { gte: since }, promotional: true },
      }),
      prisma.draft.count({ where: { accountId, status: 'posted', postedAt: { gte: startOfDay } } }),
    ]);
    return { total, promo, today };
  };

  for (const d of draftDefs) {
    const acct = ACC[d.acct]!;
    const sub = d.sub ? SUB[d.sub]! : null;
    const opp =
      'opp' in d && d.opp
        ? await prisma.opportunity.findUnique({ where: { id: OPP[d.opp]! }, include: { post: true } })
        : null;
    const convId = 'conv' in d && d.conv ? CONV[d.conv]! : null;
    const conv = convId
      ? await prisma.conversation.findUnique({ where: { id: convId }, include: { messages: true } })
      : null;
    const st = await promoStats(acct.id);
    const checks = evaluateDraft({
      now: NOW,
      timeZone: 'America/New_York',
      draft: { type: d.type, body: d.body, promotional: d.promo },
      account: {
        disclosureLine: acct.disclosureLine,
        dailyPostLimit: acct.dailyPostLimit,
        postedToday: st.today,
        karma: acct.karma,
        accountCreatedAt: acct.accountCreatedAt,
        health: acct.health,
        selfPromoMax: acct.selfPromoMax,
        promoItems7d: st.promo,
        totalItems7d: st.total,
      },
      subreddit: sub
        ? {
            name: sub.name,
            linkRule: sub.linkRule as never,
            minKarma: sub.minKarma,
            minAccountAgeDays: sub.minAccountAgeDays,
          }
        : null,
      post: opp ? { postedAt: opp.post.postedAt } : null,
      conversation: conv
        ? {
            inboundCount: conv.messages.filter((m) => m.direction === 'in').length,
            isFirstOutbound: !conv.messages.some((m) => m.direction === 'out'),
          }
        : null,
      competitors: ['Asana', 'ClickUp', 'Notion', 'Jira', 'Linear', 'Trello'],
    });
    const created = minAgo(d.wait);
    const draft = await prisma.draft.create({
      data: {
        ...W,
        opportunityId: opp?.id ?? null,
        conversationId: convId,
        agentId: AG[d.agent]!,
        accountId: acct.id,
        type: d.type,
        title: 'title' in d ? d.title : null,
        body: d.body,
        reasoning: d.reasoning,
        ruleChecks: checks,
        trackedLinkId: d.link ? LINK[d.link]! : null,
        status: 'pending',
        promotional: d.promo,
        createdAt: created,
        bodyHistory: [{ body: d.body, at: created.toISOString(), by: d.agent }],
      },
    });
    await prisma.auditEvent.create({
      data: {
        ...W,
        action: 'draft.created',
        targetType: 'Draft',
        targetId: draft.id,
        accountId: acct.id,
        meta: { agent: d.agent, type: d.type },
        at: created,
      },
    });
  }

  // ── a scheduled launch post and a rejected DM (audit history) ──
  const rejected = await prisma.draft.create({
    data: {
      ...W,
      agentId: AG.sam!,
      accountId: ACC.sam!.id,
      type: 'dm',
      body: 'Hi! Saw your post about Notion — want a demo of Acme? Support at Acme.',
      status: 'rejected',
      rejectReason: 'Too salesy for a first touch',
      approverMemberId: M.jane!,
      createdAt: hAgo(5),
      promotional: true,
    },
  });

  // ── attribution: signups/payments for converted leads ──
  const paid = [
    { user: 'fernhill_ops', email: 'ops@fernhill.io', cents: 49000, link: 'clickup-speed', d: 5 },
    { user: 'kito_pm', email: 'kito@studiokito.com', cents: 14700, link: 'pm-6team', d: 9 },
  ];
  for (const p of paid) {
    const vid = `v_lead_${p.user}`;
    await prisma.clickEvent.create({
      data: {
        ...W,
        trackedLinkId: LINK[p.link]!,
        visitorId: vid,
        referer: 'https://www.reddit.com/',
        occurredAt: dAgo(p.d + 2),
      },
    });
    const signup = await prisma.siteEvent.create({
      data: { ...W, visitorId: vid, kind: 'signup', email: p.email, occurredAt: dAgo(p.d + 1) },
    });
    const pay = await prisma.siteEvent.create({
      data: {
        ...W,
        visitorId: vid,
        kind: 'payment',
        email: p.email,
        amountCents: p.cents,
        stripeCustomerId: `cus_seed_${p.user}`,
        occurredAt: dAgo(p.d),
      },
    });
    for (const ev of [signup, pay])
      await prisma.attribution.create({
        data: {
          ...W,
          leadId: LEAD[p.user]!,
          siteEventId: ev.id,
          trackedLinkId: LINK[p.link]!,
          model: 'last_click',
          weight: 1,
        },
      });
  }
  for (const t of [
    { user: 'devon_builds', email: 'devon@tinyhq.co', link: 'pm-6team', d: 1 },
    { user: 'mkt_rhea', email: 'rhea@brightloop.io', link: 'sprints-8', d: 0.2 },
  ]) {
    const vid = `v_lead_${t.user}`;
    await prisma.clickEvent.create({
      data: {
        ...W,
        trackedLinkId: LINK[t.link]!,
        visitorId: vid,
        referer: 'https://www.reddit.com/',
        occurredAt: dAgo(t.d + 0.5),
      },
    });
    const ev = await prisma.siteEvent.create({
      data: { ...W, visitorId: vid, kind: 'trial', email: t.email, occurredAt: dAgo(t.d) },
    });
    await prisma.attribution.create({
      data: {
        ...W,
        leadId: LEAD[t.user]!,
        siteEventId: ev.id,
        trackedLinkId: LINK[t.link]!,
        model: 'last_click',
        weight: 1,
      },
    });
  }
  // other paying customers (unattributed to a named lead) so revenue totals match the mockup ($4,320 / 30 days)
  const extra = [
    36500, 24900, 9900, 14700, 9800, 49000, 9800, 14700, 11000, 19800, 14700, 9900, 18000, 18000, 29400, 4900,
    4900, 9800, 4900,
  ];
  for (const [i, cents] of extra.entries()) {
    const link = linkDefs[i % linkDefs.length]!;
    const ev = await prisma.siteEvent.create({
      data: {
        ...W,
        visitorId: `v_${link.slug}_${i}`,
        kind: 'payment',
        amountCents: cents,
        occurredAt: dAgo(1 + (i % 27)),
      },
    });
    await prisma.attribution.create({
      data: { ...W, siteEventId: ev.id, trackedLinkId: LINK[link.label]!, model: 'last_click', weight: 1 },
    });
  }

  // ── audit log (Settings mockup + Home activity) ──
  const audit = [
    {
      action: 'draft.posted',
      by: 'jane',
      acct: 'jane',
      meta: {
        agent: 'Maya',
        item: 'Comment in r/projectmanagement · “We hit the same wall at 6 people…”',
        disclosure: true,
      },
      at: minAgo(12),
    },
    {
      action: 'draft.approved',
      by: 'jane',
      acct: 'jane',
      meta: { agent: 'Maya', item: 'Reply in r/projectmanagement', disclosure: true },
      at: minAgo(13),
    },
    {
      action: 'lead.stage_changed',
      by: null,
      acct: null,
      meta: { lead: 'u/devon_builds', from: 'interested', to: 'trial' },
      at: hAgo(1),
    },
    {
      action: 'draft.rejected',
      by: 'jane',
      acct: 'sam',
      meta: { agent: 'Sam', item: 'DM follow-up to u/quiet_lists', reason: 'Too salesy for a first touch' },
      at: hAgo(4),
      target: rejected.id,
    },
    {
      action: 'draft.posted',
      by: 'jane',
      acct: 'sam',
      meta: { agent: 'Sam', item: 'DM to u/ops_kat · guest access answer', disclosure: true },
      at: dAgo(0.7),
    },
    {
      action: 'draft.posted',
      by: 'leo',
      acct: 'leo',
      meta: { agent: 'Leo', item: 'Comment in r/SaaS · ClickUp speed thread', edits: 2, disclosure: true },
      at: dAgo(1),
    },
    {
      action: 'draft.scheduled',
      by: 'jane',
      acct: 'leo',
      meta: { agent: 'Leo', item: 'Launch post in r/SaaS · Sat 10:00' },
      at: dAgo(2),
    },
    {
      action: 'session.started',
      by: 'jane',
      acct: 'jane',
      meta: { profile: 'Jane · Chrome', reason: 'Reddit asked for verification' },
      at: minAgo(20),
    },
  ];
  for (const a of audit)
    await prisma.auditEvent.create({
      data: {
        ...W,
        actorMemberId: a.by ? M[a.by]! : null,
        action: a.action,
        targetType:
          a.action.split('.')[0] === 'lead'
            ? 'Lead'
            : a.action.startsWith('session')
              ? 'BrowserSession'
              : 'Draft',
        targetId: a.target ?? 'seed',
        accountId: a.acct ? ACC[a.acct]!.id : null,
        meta: a.meta,
        at: a.at,
      },
    });

  // ── an active human VNC session on Jane's profile ──
  const sess = await prisma.browserSession.create({
    data: {
      ...W,
      profileId: PROFILE.jane!,
      driver: 'human',
      startedByMemberId: M.jane!,
      agentId: AG.maya!,
      reason: 'Reddit asked for verification while posting approved reply',
      startedAt: minAgo(4),
    },
  });
  const log = [
    [11, 'System', 'profile launched from saved session'],
    [11, 'Maya', 'proxy check passed · 73.218.44.19'],
    [10, 'Maya', 'opened thread t3_1h8k2q to post approved reply'],
    [9, 'Maya', 'stopped: verification prompt, asked for a human'],
    [8, 'Jane Park', 'took control · Maya paused'],
    [6, 'Jane Park', 'completed Reddit verification'],
    [4, 'Jane Park', 'typing in the comment box'],
  ] as const;
  for (const [m, who, text] of log)
    await prisma.auditEvent.create({
      data: {
        ...W,
        actorMemberId: who === 'Jane Park' ? M.jane! : null,
        action: 'session.log',
        targetType: 'BrowserSession',
        targetId: sess.id,
        sessionId: sess.id,
        accountId: ACC.jane!.id,
        meta: { who, text },
        at: minAgo(m),
      },
    });

  // ── notifications ──
  await prisma.notification.createMany({
    data: [
      {
        ...W,
        memberId: M.jane!,
        kind: 'needs_human',
        payload: { profileId: PROFILE.jane, text: 'Reddit asked for verification on Jane · Chrome' },
      },
      {
        ...W,
        memberId: M.jane!,
        kind: 'draft_waiting',
        payload: { text: 'Leo’s launch post has waited 3h' },
      },
      { ...W, memberId: M.jane!, kind: 'new_dm', payload: { text: 'u/ops_kat replied in DM' } },
    ],
  });

  const counts = {
    opportunities: await prisma.opportunity.count(),
    pendingDrafts: await prisma.draft.count({ where: { status: 'pending' } }),
    leads: await prisma.lead.count(),
    clicks: await prisma.clickEvent.count(),
  };
  console.log('Seeded Acme:', counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
