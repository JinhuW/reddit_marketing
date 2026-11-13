/**
 * Every handler module, one line each. Wave 2 tasks replace a module's body (T21 profile, T22 actions, T24 vnc)
 * and keep its export name, so this file does not change. Every `Cmd.kind` must be claimed by exactly one module.
 */
import type { AgentModule } from '../registry';
import { actionsModule } from './actions';
import { healthModule } from './health';
import { profileModule } from './profile';
import { proxyModule } from './proxy';
import { vncModule } from './vnc';

export const modules: readonly AgentModule[] = [
  healthModule,
  profileModule,
  actionsModule,
  vncModule,
  proxyModule,
];
