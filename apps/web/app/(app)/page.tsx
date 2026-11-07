import { PageHeader } from '@/components/ui/page-header';
import { requireMember } from '@/lib/session';

export default async function Home() {
  const me = await requireMember();
  return <PageHeader title={`Good morning, ${(me.user.name ?? '').split(' ')[0]}`} />;
}
