'use client';

import { saveDetailsAction, trashProfileAction } from '@/lib/actions/browser-list';
import { useActionState } from 'react';
import { Msg } from './BrowserControls';
import type { ActionState } from './action-state';
import { tagChip } from './list-params';
import type { ProfileView } from './view';

/** Drawer section (plan 0004): the group, tags and notes of one browser. */
export function ProfileDetails({
  p,
  canEdit,
  groups,
  tags,
}: {
  p: ProfileView;
  canEdit: boolean;
  groups: { id: string; name: string }[];
  tags: { id: string; name: string; color: string }[];
}) {
  const [state, act, saving] = useActionState<ActionState | null, FormData>(saveDetailsAction, null);
  const has = new Set(p.tags.map((t) => t.id));
  return (
    <section
      className="flex flex-col gap-2.5 border-b border-line-soft px-[18px] py-4 text-[12.5px]"
      aria-labelledby={`details-h-${p.id}`}
      data-testid="profile-details"
    >
      <h3 id={`details-h-${p.id}`} className="m-0 text-[12.5px] font-semibold">
        Group, tags and notes
      </h3>
      {/* Keyed on the saved values, so a save elsewhere (bulk bar, quick edit) shows here too. */}
      <form
        key={`${p.group?.id ?? ''}|${[...has].join(',')}|${p.notes}`}
        action={act}
        className="flex flex-col gap-2.5"
      >
        <input type="hidden" name="profileId" value={p.id} />
        <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0" disabled={!canEdit}>
          <div className="flex flex-col gap-[5px]">
            <label htmlFor={`group-${p.id}`} className="text-xs font-semibold">
              Group
            </label>
            <select id={`group-${p.id}`} name="groupId" className="field" defaultValue={p.group?.id ?? ''}>
              <option value="">No group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          {tags.length ? (
            <div className="flex flex-col gap-[5px]">
              <span className="text-xs font-semibold">Tags</span>
              <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                {tags.map((t) => (
                  <label key={t.id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      name="tagIds"
                      value={t.id}
                      defaultChecked={has.has(t.id)}
                      className="m-0 accent-[var(--ink)]"
                    />
                    <span className={`chip ${tagChip(t.color)}`}>{t.name}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <div className="flex flex-col gap-[5px]">
            <label htmlFor={`notes-${p.id}`} className="text-xs font-semibold">
              Notes
            </label>
            <textarea
              id={`notes-${p.id}`}
              name="notes"
              className="field min-h-[60px] resize-y py-2 leading-snug"
              maxLength={2000}
              defaultValue={p.notes}
              placeholder="Anything the team should know about this browser"
            />
          </div>
          {canEdit ? (
            <button type="submit" className="btn !h-7 self-start" disabled={saving}>
              {saving ? 'Saving…' : 'Save details'}
            </button>
          ) : null}
        </fieldset>
      </form>
      <Msg s={state} />
    </section>
  );
}

/** Drawer footer (the artboard's "Delete profile"): moves the browser to the trash. */
export function DeleteProfile({ p }: { p: ProfileView }) {
  const [state, act, busy] = useActionState<ActionState | null, FormData>(trashProfileAction, null);
  return (
    <form action={act} className="flex flex-col gap-2">
      <input type="hidden" name="profileId" value={p.id} />
      <button type="submit" className="btn btn-ghost text-bad" disabled={busy}>
        {busy ? 'Deleting…' : 'Delete profile'}
      </button>
      <span className="muted text-xs">Goes to the trash; restore it within 30 days.</span>
      {state && !state.ok ? <Msg s={state} /> : null}
    </form>
  );
}
