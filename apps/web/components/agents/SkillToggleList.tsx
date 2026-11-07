'use client';

import { type ActionState, saveSkill } from '@/lib/actions/agents';
import type { SkillKey } from '@threadline/shared';
import { useActionState } from 'react';
import { FormMessage } from './FormMessage';

const SKILLS: Record<SkillKey, { title: string; desc: string }> = {
  compare_answer: {
    title: 'Comparison answers',
    desc: 'Answers “X vs Y” and “alternative to X” questions honestly, with the trade-offs.',
  },
  launch_post: {
    title: 'Launch posts',
    desc: 'Drafts launch posts and AMAs for subs that allow them. Always goes to approval.',
  },
  demo_followup: {
    title: 'Demo follow-ups',
    desc: 'Follows up by DM only with people who replied or messaged first.',
  },
  thread_to_blog: {
    title: 'Thread to blog',
    desc: 'Turns a good thread into a blog outline. Never quotes usernames.',
  },
};

export function SkillToggleList({
  agentId,
  skills,
  canEdit,
}: {
  agentId: string;
  skills: { key: SkillKey; enabled: boolean; promptOverride: string | null }[];
  canEdit: boolean;
}) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {skills.map((s) => (
        <SkillRow key={s.key} agentId={agentId} skill={s} canEdit={canEdit} />
      ))}
    </ul>
  );
}

function SkillRow({
  agentId,
  skill,
  canEdit,
}: {
  agentId: string;
  skill: { key: SkillKey; enabled: boolean; promptOverride: string | null };
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveSkill, {});
  const meta = SKILLS[skill.key];
  return (
    <li
      className="border-b border-line-soft px-[18px] py-4 last:border-b-0"
      data-testid={`skill-${skill.key}`}
    >
      <form action={action} className="flex flex-col gap-2.5">
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="key" value={skill.key} />
        <fieldset disabled={!canEdit || pending} className="contents">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold">{meta.title}</div>
              <div className="muted text-[12.5px]">{meta.desc}</div>
            </div>
            <label className="flex items-center gap-2 text-[13px] font-medium">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={skill.enabled}
                aria-label={`Enable ${meta.title}`}
                className="h-4 w-4 accent-[var(--ink)]"
                onChange={(e) => e.currentTarget.form?.requestSubmit()}
              />
              {skill.enabled ? 'On' : 'Off'}
            </label>
          </div>
          <details>
            <summary className="muted cursor-pointer text-xs">Prompt override</summary>
            <div className="mt-2 flex flex-col gap-2">
              <textarea
                name="promptOverride"
                defaultValue={skill.promptOverride ?? ''}
                aria-label={`${meta.title} prompt override`}
                placeholder="Leave empty to use the default template"
                className="field !h-auto min-h-[72px] py-2"
              />
              <button type="submit" className="btn self-start">
                Save override
              </button>
            </div>
          </details>
        </fieldset>
        <FormMessage state={state} />
      </form>
    </li>
  );
}
