/**
 * Playwright actions over CDP (plan §4 T22): `action.submitComment`, `action.sendDm`, `profile.testProxy`,
 * `profile.whoami` (plan 0002) and `profile.signIn` (plan 0003).
 * The work lives in `src/actions/`; this file only registers it. Proxy credentials come from
 * `profileProxies`, which the profile module fills on `profile.start`.
 */
import { createActionHandlers, profileProxies, proxyAuthWatchers } from '../actions';
import type { AgentModule } from '../registry';

export const actionsModule: AgentModule = {
  name: 'actions',
  handlers: createActionHandlers(),
  stop: () => {
    proxyAuthWatchers.clear();
    profileProxies.clear();
  },
};
