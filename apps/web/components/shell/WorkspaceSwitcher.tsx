'use client';

import { Icon } from '@/components/ui/icon';
import { switchWorkspace } from '@/lib/actions/workspace';
import { useState } from 'react';

export function WorkspaceSwitcher({
  workspaces,
  current,
}: {
  workspaces: { name: string; slug: string }[];
  current: { name: string; slug: string };
}) {
  const [open, setOpen] = useState(false);
  const idx = workspaces.findIndex((w) => w.slug === current.slug) + 1;
  return (
    <div className="relative mx-0.5 mb-2">
      <button
        type="button"
        aria-label="Switch workspace"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-full items-center gap-2 rounded-[10px] border border-line bg-surface px-2 text-left text-[12.5px] font-medium"
      >
        <span className="grid h-[18px] w-[18px] place-items-center rounded-[5px] bg-inverse text-[9px] font-bold text-inverse-ink">
          {current.name[0]}
        </span>
        <span className="flex-1">{current.name}</span>
        {workspaces.length > 1 ? (
          <span className="text-[11px] text-muted">
            {idx} of {workspaces.length}
          </span>
        ) : null}
        <Icon name="updown" size={13} className="text-faint" />
      </button>
      {open ? (
        <ul className="absolute top-9 right-0 left-0 z-20 m-0 list-none rounded-[12px] border border-line bg-surface p-1">
          {workspaces.map((w) => (
            <li key={w.slug}>
              <form action={switchWorkspace}>
                <input type="hidden" name="slug" value={w.slug} />
                <button
                  type="submit"
                  className={`w-full rounded-[9px] px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-3 ${w.slug === current.slug ? 'font-semibold' : ''}`}
                >
                  {w.name}
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
