/**
 * STUB until T21 (docker manager) lands. T21 replaces this file's body and keeps the `profileModule` export;
 * its `start()` should call `ctx.status.setProvider(...)` with real running/seats/imageDigest/docker readers.
 */
import { type AgentModule, notImplemented } from '../registry';

export const profileModule: AgentModule = {
  name: 'profile',
  handlers: {
    'profile.start': notImplemented('profile.start'),
    'profile.stop': notImplemented('profile.stop'),
  },
};
