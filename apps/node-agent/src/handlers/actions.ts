/**
 * Playwright actions over CDP (plan §4 T22): `action.submitComment`, `action.sendDm`, `profile.testProxy` and
 * `profile.whoami` (plan 0002).
 * The work lives in `src/actions/`; this file only registers it. Proxy credentials come from
 * `profileProxies`, which the profile module fills on `profile.start`.
 */
import { createActionHandlers, profileProxies } from '../actions';
import type { AgentModule } from '../registry';

export const actionsModule: AgentModule = {
  name: 'actions',
  handlers: createActionHandlers(),
  stop: () => profileProxies.clear(),
};
