import type { IconName } from '@/components/ui/icon';

export type NavId =
  | 'home'
  | 'opportunities'
  | 'approvals'
  | 'conversations'
  | 'leads'
  | 'analytics'
  | 'agents'
  | 'browsers'
  | 'accounts'
  | 'tracking'
  | 'settings';

export interface NavItem {
  id: NavId;
  label: string;
  href: string;
  icon: IconName;
  badge?: 'newOpps' | 'pendingDrafts' | 'unreadConversations';
  beta?: boolean;
}
export interface NavGroup {
  id: 'work' | 'crm' | 'agents' | 'setup';
  label: string;
  icon: IconName;
  items: NavItem[];
  dividerBefore?: boolean;
}

export const NAV: NavGroup[] = [
  {
    id: 'work',
    label: 'Work',
    icon: 'work',
    items: [
      { id: 'home', label: 'Home', href: '/', icon: 'home' },
      {
        id: 'opportunities',
        label: 'Opportunities',
        href: '/opportunities',
        icon: 'search',
        badge: 'newOpps',
      },
      { id: 'approvals', label: 'Approvals', href: '/approvals', icon: 'check', badge: 'pendingDrafts' },
      {
        id: 'conversations',
        label: 'Conversations',
        href: '/conversations',
        icon: 'chat',
        badge: 'unreadConversations',
      },
    ],
  },
  {
    id: 'crm',
    label: 'CRM',
    icon: 'crm',
    items: [
      { id: 'leads', label: 'Leads', href: '/leads', icon: 'leads' },
      { id: 'analytics', label: 'Analytics', href: '/analytics', icon: 'analytics' },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'bot',
    items: [
      { id: 'agents', label: 'Agent employees', href: '/agents', icon: 'agent' },
      { id: 'browsers', label: 'Browsers', href: '/browsers', icon: 'browser', beta: true },
      { id: 'accounts', label: 'Reddit accounts', href: '/accounts', icon: 'account' },
    ],
  },
  {
    id: 'setup',
    label: 'Workspace',
    icon: 'workspace',
    dividerBefore: true,
    items: [
      { id: 'tracking', label: 'Tracking', href: '/tracking', icon: 'tracking' },
      { id: 'settings', label: 'Settings', href: '/settings', icon: 'settings' },
    ],
  },
];

export function activeNav(pathname: string): NavId {
  if (pathname === '/') return 'home';
  const seg = pathname.split('/')[1] ?? '';
  const all = NAV.flatMap((g) => g.items);
  return all.find((i) => i.href === `/${seg}`)?.id ?? 'home';
}
