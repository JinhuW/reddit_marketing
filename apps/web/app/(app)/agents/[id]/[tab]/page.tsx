import { AgentsView, TABS, type Tab } from '@/components/agents/AgentsView';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'Agent employees' };

export default async function Page({ params }: { params: Promise<{ id: string; tab: string }> }) {
  const { id, tab } = await params;
  if (!(TABS as readonly string[]).includes(tab)) notFound();
  return <AgentsView selectedId={id} tab={tab as Tab} />;
}
