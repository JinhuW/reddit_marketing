import type { LinkMedium } from '@threadline/shared';

export const LINK_MEDIUM_OPTIONS: { value: LinkMedium; label: string }[] = [
  { value: 'comment', label: 'Comment' },
  { value: 'post', label: 'Post' },
  { value: 'dm', label: 'DM' },
];
