'use client';

import { markConversationRead } from '@/lib/actions/conversations';
import { useEffect } from 'react';

/** Marks the open conversation read once it is shown. */
export function MarkRead({ id, unread }: { id: string; unread: boolean }) {
  useEffect(() => {
    if (unread) void markConversationRead(id);
  }, [id, unread]);
  return null;
}
