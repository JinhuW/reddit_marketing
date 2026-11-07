import type { Job } from 'bullmq';

/** draft.generate — wired to the drafts repository in the next commit. */
export async function draftGenerate(_job: Job): Promise<never> {
  throw new Error('draft.generate is not wired yet');
}
