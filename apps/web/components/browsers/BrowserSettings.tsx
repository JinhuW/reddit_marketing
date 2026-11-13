'use client';

import { saveBrowserSettingsAction } from '@/lib/actions/browsers';
import { useActionState, useState } from 'react';
import { Msg } from './BrowserControls';
import type { ActionState } from './action-state';
import type { ProfileView } from './view';

export const COOKIE_PLACEHOLDER =
  '[{"domain": ".reddit.com", "name": "reddit_session", "value": "…", "path": "/", "expirationDate": 1798000000, "httpOnly": true, "secure": true}]';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** "Cookies pending import" / "Imported Nov 8, 2026" / "None imported". Never the cookies themselves. */
export function cookieStatus(c: ProfileView['cookies']): string {
  if (c.pending) return 'Pending: imported on the next sign-in';
  if (c.importedAt) return `Imported ${day(c.importedAt)}`;
  return 'None imported';
}

/**
 * Plan 0003: the browser's name, start tab (标签页) and cookie import. The cookie box is write-only: what was
 * pasted is encrypted, imported by the next `profile.signIn`, then dropped; it is never shown again.
 */
export function BrowserSettings({ p, canEdit }: { p: ProfileView; canEdit: boolean }) {
  const [state, act, saving] = useActionState<ActionState | null, FormData>(
    async (prev: ActionState | null, form: FormData) => {
      const r = await saveBrowserSettingsAction(prev, form);
      if (r.ok) setCookies('');
      return r;
    },
    null,
  );
  // Controlled, so a refused submit keeps what was typed (React resets uncontrolled fields after an action).
  const [name, setName] = useState(p.name);
  const [startUrl, setStartUrl] = useState(p.startUrl ?? '');
  const [cookies, setCookies] = useState('');
  const extraSaved = p.extraStartUrls.join('\n');
  const [extra, setExtra] = useState(extraSaved);
  const [seeded, setSeeded] = useState({ name: p.name, startUrl: p.startUrl, extra: extraSaved });
  if (seeded.name !== p.name || seeded.startUrl !== p.startUrl || seeded.extra !== extraSaved) {
    setSeeded({ name: p.name, startUrl: p.startUrl, extra: extraSaved });
    setName(p.name);
    setStartUrl(p.startUrl ?? '');
    setExtra(extraSaved);
  }

  return (
    <section
      className="flex flex-col gap-2.5 border-b border-line-soft px-[18px] py-4 text-[12.5px]"
      aria-labelledby={`settings-h-${p.id}`}
      data-testid="browser-settings"
    >
      <h3 id={`settings-h-${p.id}`} className="m-0 text-[12.5px] font-semibold">
        Start tab and cookies
      </h3>
      <form action={act} className="flex flex-col gap-2.5">
        <input type="hidden" name="profileId" value={p.id} />
        <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0" disabled={!canEdit}>
          <div className="flex flex-col gap-[5px]">
            <label htmlFor={`bname-${p.id}`} className="text-xs font-semibold">
              Browser name
            </label>
            <input
              id={`bname-${p.id}`}
              name="name"
              className="field"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-[5px]">
            <label htmlFor={`start-${p.id}`} className="text-xs font-semibold">
              Start tab
            </label>
            <input
              id={`start-${p.id}`}
              name="startUrl"
              className="field"
              inputMode="url"
              placeholder="https://www.reddit.com/"
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
            />
            <span className="muted text-[11.5px]">Opens on every sign-in. Empty = reddit.com.</span>
          </div>
          <div className="flex flex-col gap-[5px]">
            <label htmlFor={`extra-${p.id}`} className="text-xs font-semibold">
              More start tabs
            </label>
            <textarea
              id={`extra-${p.id}`}
              name="extraStartUrls"
              className="field min-h-[52px] resize-y py-2 leading-snug"
              spellCheck={false}
              placeholder={'https://mail.example.com/\nhttps://www.reddit.com/message/inbox'}
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            />
            <span className="muted text-[11.5px]">
              One address per line, up to 9. Each opens in its own tab.
            </span>
          </div>
          <div className="flex flex-col gap-[5px]">
            <div className="flex items-center gap-2">
              <label htmlFor={`cookies-${p.id}`} className="text-xs font-semibold">
                Cookie
              </label>
              <span
                className={`chip ${p.cookies.pending ? 'chip-warn' : p.cookies.importedAt ? 'chip-ok' : 'chip-mid'}`}
                data-testid="cookie-status"
              >
                {cookieStatus(p.cookies)}
              </span>
            </div>
            <textarea
              id={`cookies-${p.id}`}
              name="cookies"
              className="field num min-h-[88px] resize-y py-2 font-mono text-[11.5px] leading-snug"
              spellCheck={false}
              autoComplete="off"
              placeholder={COOKIE_PLACEHOLDER}
              value={cookies}
              onChange={(e) => setCookies(e.target.value)}
            />
            <span className="muted text-[11.5px]">
              Paste a cookie export: JSON (Cookie-Editor, EditThisCookie, another browser tool), a cookies.txt
              file, or name=value pairs. Stored encrypted until the next sign-in imports it; never shown
              again. Leave empty to keep
              {p.cookies.pending ? ' the pending cookies.' : ' the browser’s cookies as they are.'}
            </span>
            {p.cookies.pending ? (
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" name="dropCookies" className="m-0 accent-[var(--ink)]" />
                Drop the pending cookies
              </label>
            ) : null}
          </div>
          {canEdit ? (
            <button type="submit" className="btn !h-7 self-start" disabled={saving}>
              {saving ? 'Saving…' : 'Save start tab and cookies'}
            </button>
          ) : null}
        </fieldset>
      </form>
      <Msg s={state} />
    </section>
  );
}
