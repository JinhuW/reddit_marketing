/** `proxy.check` / `proxy.rotate` (plan 0004 phase 3). The work lives in `src/actions/proxy-pool.ts`. */
import { createProxyPoolHandlers } from '../actions/proxy-pool';
import type { AgentModule } from '../registry';

export const proxyModule: AgentModule = { name: 'proxy', handlers: createProxyPoolHandlers() };
