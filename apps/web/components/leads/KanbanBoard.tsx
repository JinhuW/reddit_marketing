'use client';

import { Avatar } from '@/components/ui/avatar';
import { moveStage } from '@/lib/actions/leads';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { LEAD_STAGE_LABEL, type LeadStage } from '@threadline/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { lastTouch, money, scoreChip } from './format';

export interface KanbanCard {
  id: string;
  username: string;
  sub: string | null;
  score: number;
  lastActivityAt: string;
  owner: string | null;
  dealValueCents: number;
  stage: LeadStage;
}

export function KanbanBoard({ stages, cards: initial }: { stages: LeadStage[]; cards: KanbanCard[] }) {
  const router = useRouter();
  const [cards, setCards] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  useEffect(() => setCards(initial), [initial]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const to = e.over?.id as LeadStage | undefined;
    const card = cards.find((c) => c.id === id);
    if (!card || !to || card.stage === to) return;
    const from = card.stage;
    setError(null);
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, stage: to } : c)));
    start(async () => {
      const r = await moveStage({ leadId: id, stage: to });
      if (!r.ok) {
        setCards((cs) => cs.map((c) => (c.id === id ? { ...c, stage: from } : c)));
        setError(r.error);
      } else router.refresh();
    });
  };

  return (
    <>
      {error ? (
        <p role="alert" className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-[13px] text-bad">
          {error}
        </p>
      ) : null}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-7 items-start gap-3 overflow-x-auto max-xl:grid-cols-[repeat(7,minmax(180px,1fr))]">
          {stages.map((s) => {
            const list = cards.filter((c) => c.stage === s);
            return <Column key={s} stage={s} cards={list} />;
          })}
        </div>
      </DndContext>
    </>
  );
}

function Column({ stage, cards }: { stage: LeadStage; cards: KanbanCard[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const value = cards.reduce((s, c) => s + c.dealValueCents, 0);
  return (
    <section
      ref={setNodeRef}
      aria-label={LEAD_STAGE_LABEL[stage]}
      data-stage={stage}
      className={`flex min-h-[120px] min-w-0 flex-col gap-2 rounded-[14px] p-2 ${isOver ? 'bg-neutral-soft outline-2 outline-ink/20' : 'bg-surface-3'}`}
    >
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <h2 className="m-0 truncate text-[13px] font-semibold">{LEAD_STAGE_LABEL[stage]}</h2>
        <span className="num muted text-xs">{cards.length}</span>
        <div className="flex-1" />
        <span
          className={`num text-[11.5px] font-medium ${stage === 'customer' ? 'text-accent' : 'text-muted'}`}
        >
          {money(value)}
        </span>
      </div>
      {cards.map((c) => (
        <Card key={c.id} card={c} />
      ))}
    </section>
  );
}

function Card({ card }: { card: KanbanCard }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id });
  return (
    <Link
      ref={setNodeRef}
      href={`/leads/${card.id}`}
      data-lead={card.username}
      {...listeners}
      {...attributes}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      className={`flex cursor-grab flex-col gap-1.5 rounded-[12px] border border-line bg-surface px-3 py-2.5 hover:border-line-strong ${isDragging ? 'relative z-10 opacity-90' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">u/{card.username}</span>
        <span className={`${scoreChip(card.score)} num !h-[18px] !px-1.5`}>{card.score}</span>
      </div>
      <div className="muted text-xs">{card.sub ? `r/${card.sub}` : '—'}</div>
      <div className="muted flex items-center gap-1.5 border-t border-line-soft pt-[7px] text-[11.5px]">
        {card.owner ? <Avatar name={card.owner} size={18} /> : null}
        <span className="flex-1">{lastTouch(new Date(card.lastActivityAt))}</span>
        <span className="num font-semibold text-ink">
          {card.dealValueCents ? money(card.dealValueCents) : ''}
        </span>
      </div>
    </Link>
  );
}
