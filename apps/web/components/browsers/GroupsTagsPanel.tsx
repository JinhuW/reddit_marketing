'use client';

import {
  createGroupAction,
  createTagAction,
  deleteGroupAction,
  deleteTagAction,
  renameGroupAction,
} from '@/lib/actions/browser-list';
import { BrowserTagColor } from '@threadline/shared';
import { useActionState } from 'react';
import { Msg } from './BrowserControls';
import type { ActionState } from './action-state';
import { tagChip } from './list-params';

type Act = (prev: ActionState | null, form: FormData) => Promise<ActionState>;
const useAct = (fn: Act) => useActionState<ActionState | null, FormData>(fn, null);

function GroupRow({
  g,
  canEdit,
}: { g: { id: string; name: string; profileCount: number }; canEdit: boolean }) {
  const [renamed, rename, renaming] = useAct(renameGroupAction);
  const [deleted, del, deleting] = useAct(deleteGroupAction);
  return (
    <li className="flex flex-col gap-1" data-group={g.name}>
      <div className="flex items-center gap-1.5">
        <form action={rename} className="flex flex-1 items-center gap-1.5">
          <input type="hidden" name="id" value={g.id} />
          <input
            name="name"
            className="field !h-7 flex-1"
            defaultValue={g.name}
            maxLength={40}
            aria-label={`Name of group ${g.name}`}
            disabled={!canEdit}
          />
          <span className="muted num w-[70px] text-xs">
            {g.profileCount} {g.profileCount === 1 ? 'browser' : 'browsers'}
          </span>
          {canEdit ? (
            <button type="submit" className="btn !h-7 !px-2" disabled={renaming}>
              Rename
            </button>
          ) : null}
        </form>
        {canEdit ? (
          <form action={del}>
            <input type="hidden" name="id" value={g.id} />
            <button type="submit" className="btn btn-ghost !h-7 !px-2 text-bad" disabled={deleting}>
              Delete
            </button>
          </form>
        ) : null}
      </div>
      <Msg s={renamed && !renamed.ok ? renamed : deleted && !deleted.ok ? deleted : null} />
    </li>
  );
}

function TagRow({
  t,
  canEdit,
}: { t: { id: string; name: string; color: string; profileCount: number }; canEdit: boolean }) {
  const [state, del, deleting] = useAct(deleteTagAction);
  return (
    <li className="flex items-center gap-1.5" data-tag={t.name}>
      <span className={`chip ${tagChip(t.color)}`}>{t.name}</span>
      <span className="muted num flex-1 text-xs">
        {t.profileCount} {t.profileCount === 1 ? 'browser' : 'browsers'}
      </span>
      {canEdit ? (
        <form action={del}>
          <input type="hidden" name="id" value={t.id} />
          <button type="submit" className="btn btn-ghost !h-7 !px-2 text-bad" disabled={deleting}>
            Delete
          </button>
        </form>
      ) : null}
      {state && !state.ok ? <Msg s={state} /> : null}
    </li>
  );
}

/**
 * Groups and tags of the Browsers screen (plan 0004). A browser is in at most one group and can carry several
 * tags. Deleting a group or tag never deletes a browser.
 */
export function GroupsTagsPanel({
  groups,
  tags,
  canEdit,
}: {
  groups: { id: string; name: string; profileCount: number }[];
  tags: { id: string; name: string; color: string; profileCount: number }[];
  canEdit: boolean;
}) {
  const [newGroup, addGroup, addingGroup] = useAct(createGroupAction);
  const [newTag, addTag, addingTag] = useAct(createTagAction);
  return (
    <section
      className="panel grid gap-5 px-[18px] py-4 text-[12.5px] md:grid-cols-2"
      aria-label="Groups and tags"
      data-testid="groups-tags"
    >
      <div className="flex flex-col gap-2.5">
        <h2 className="m-0 text-[13px] font-semibold">Groups</h2>
        {groups.length ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {groups.map((g) => (
              <GroupRow key={g.id} g={g} canEdit={canEdit} />
            ))}
          </ul>
        ) : (
          <p className="muted m-0">No groups yet. A group is a folder: each browser is in one at most.</p>
        )}
        {canEdit ? (
          <form action={addGroup} className="flex items-center gap-1.5">
            <input
              name="name"
              className="field !h-7 flex-1"
              placeholder="New group name"
              maxLength={40}
              aria-label="New group name"
              required
            />
            <button type="submit" className="btn !h-7" disabled={addingGroup}>
              Add group
            </button>
          </form>
        ) : null}
        <Msg s={newGroup} />
      </div>
      <div className="flex flex-col gap-2.5">
        <h2 className="m-0 text-[13px] font-semibold">Tags</h2>
        {tags.length ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {tags.map((t) => (
              <TagRow key={t.id} t={t} canEdit={canEdit} />
            ))}
          </ul>
        ) : (
          <p className="muted m-0">No tags yet. A browser can carry several tags.</p>
        )}
        {canEdit ? (
          <form action={addTag} className="flex items-center gap-1.5">
            <input
              name="name"
              className="field !h-7 flex-1"
              placeholder="New tag name"
              maxLength={24}
              aria-label="New tag name"
              required
            />
            <select name="color" className="field !h-7 !w-auto" aria-label="Tag color" defaultValue="gray">
              {BrowserTagColor.map((c) => (
                <option key={c} value={c}>
                  {c[0]?.toUpperCase()}
                  {c.slice(1)}
                </option>
              ))}
            </select>
            <button type="submit" className="btn !h-7" disabled={addingTag}>
              Add tag
            </button>
          </form>
        ) : null}
        <Msg s={newTag} />
      </div>
    </section>
  );
}
