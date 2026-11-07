import { Avatar } from '@/components/ui/avatar';

export function PostingAsBanner({
  account,
  approverName,
  disclosed,
  type,
}: {
  account: { username: string; roleLabel: string; ownerName: string };
  approverName: string;
  disclosed: boolean;
  type: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card bg-surface-2 px-3.5 py-2.5">
      <Avatar name={account.ownerName} size={34} />
      <div className="min-w-[240px] flex-1 leading-tight">
        <div className="text-sm">
          {type === 'dm' ? 'Sending as' : 'Posting as'} <b className="font-semibold">u/{account.username}</b>{' '}
          <span className="muted">· {account.roleLabel}</span>
        </div>
        <div className="muted text-xs">
          Approver: {approverName} · logged to the audit trail with timestamp
        </div>
      </div>
      <span className={disclosed ? 'chip chip-ok' : 'chip chip-bad'}>
        {disclosed ? 'Disclosed' : 'Missing disclosure'}
      </span>
      <span className="chip chip-line">Own account · Reddit OAuth</span>
    </div>
  );
}
