import type { Job } from 'bullmq';

/** post.publish — wired to the drafts repository in the next commit. Until then it refuses: nothing posts. */
export async function postPublish(_job: Job): Promise<never> {
  throw new Error('post.publish is not wired yet; refusing to post');
}
