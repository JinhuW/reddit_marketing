'use client';

import { useEffect, useState } from 'react';

export const COLUMNS = [
  ['group', 'Group'],
  ['tags', 'Tags'],
  ['notes', 'Notes'],
  ['account', 'Account · owner'],
  ['agent', 'Agent'],
  ['proxy', 'Proxy'],
  ['region', 'Region'],
  ['node', 'Node'],
  ['last', 'Last session'],
] as const;
const KEY = 'tl.browsers.hiddenColumns';

/**
 * Which columns the profile list shows (plan 0004). A per-browser preference in localStorage; hidden columns are
 * hidden with CSS (`data-col` on cells), so the server-rendered table does not depend on it.
 */
export function ColumnChooser() {
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      if (Array.isArray(v)) setHidden(v.filter((x) => typeof x === 'string'));
    } catch {
      // unreadable preference: show everything
    }
  }, []);
  const toggle = (col: string) => {
    const next = hidden.includes(col) ? hidden.filter((c) => c !== col) : [...hidden, col];
    setHidden(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // private mode: the choice lasts until reload
    }
  };
  const css = hidden
    .filter((c) => COLUMNS.some(([k]) => k === c))
    .map((c) => `[data-col="${c}"]{display:none}`)
    .join('');
  return (
    <details className="relative text-[12.5px]">
      <summary className="btn btn-ghost !h-[26px] cursor-pointer list-none !px-2">Columns</summary>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: built only from the fixed column keys above */}
      {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
      <div className="panel absolute right-0 z-10 mt-1 flex w-[190px] flex-col gap-1.5 p-3">
        {COLUMNS.map(([k, label]) => (
          <label key={k} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="m-0 accent-[var(--ink)]"
              checked={!hidden.includes(k)}
              onChange={() => toggle(k)}
            />
            {label}
          </label>
        ))}
      </div>
    </details>
  );
}
