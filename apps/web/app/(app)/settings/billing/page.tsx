import { requireMember } from '@/lib/session';
import { shell } from '@threadline/db';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Billing' };

const PLANS = [
  { key: 'starter', name: 'Starter', price: 69, extras: ['Lead CRM', 'Keyword tracking'] },
  { key: 'pro', name: 'Pro', price: 200, extras: ['DM inbox and follow-ups', 'Revenue attribution'] },
  { key: 'agency', name: 'Agency', price: 499, extras: ['Client workspaces', 'White-label weekly report'] },
] as const;

export default async function BillingPage() {
  const me = await requireMember();
  const current = me.workspace.plan;
  return (
    <section className="panel" aria-labelledby="billing-h">
      <div className="sect-h">
        <h2 id="billing-h">Billing</h2>
        <span className="muted text-xs">Current plan: {PLANS.find((p) => p.key === current)?.name}</span>
      </div>
      <div className="grid gap-2.5 px-[18px] py-4 md:grid-cols-3" data-testid="plan-cards">
        {PLANS.map((p) => {
          const l = shell.PLAN_LIMITS[p.key];
          const on = p.key === current;
          return (
            <div
              key={p.key}
              className={`flex flex-col gap-2 rounded-[12px] border p-3.5 text-[13px] ${on ? 'border-ink' : 'border-line'}`}
            >
              <div className="flex items-center gap-2 font-semibold">
                {p.name}
                {on ? <span className="chip chip-ok">Current</span> : null}
              </div>
              <div className="num text-xl font-semibold">
                ${p.price}
                <span className="muted text-xs font-normal"> /mo</span>
              </div>
              <ul className="m-0 flex flex-col gap-1 pl-4 text-ink-2">
                <li>
                  {l.agents} agent{l.agents === 1 ? '' : 's'}, {l.accounts} account
                  {l.accounts === 1 ? '' : 's'}
                </li>
                <li>{l.repliesPerMonth.toLocaleString('en-US')} replies / month</li>
                {p.extras.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="muted m-0 border-t border-line-soft px-[18px] py-3 text-xs">
        Plan changes and invoices move to Stripe Billing in M8. Limits above are already enforced in the app.
      </p>
    </section>
  );
}
