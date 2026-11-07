/** STUB until T22 (Playwright actions) lands. T22 replaces this file's body and keeps the `actionsModule` export. */
import { type AgentModule, notImplemented } from '../registry';

export const actionsModule: AgentModule = {
  name: 'actions',
  handlers: {
    'action.submitComment': notImplemented('action.submitComment'),
    'action.sendDm': notImplemented('action.sendDm'),
    'profile.testProxy': notImplemented('profile.testProxy'),
  },
};
