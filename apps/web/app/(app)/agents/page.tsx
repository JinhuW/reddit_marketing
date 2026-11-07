import { AgentsView } from '@/components/agents/AgentsView';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Agent employees' };

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ id?: string; new?: string }> }) {
  const sp = await searchParams;
  return <AgentsView selectedId={sp.id} tab="persona" isNew={sp.new === '1'} />;
}
