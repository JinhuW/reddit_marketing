/** STUB until T24 (VNC relay) lands. T24 replaces this file's body and keeps the `vncModule` export. */
import { type AgentModule, notImplemented } from '../registry';

export const vncModule: AgentModule = {
  name: 'vnc',
  handlers: {
    'vnc.open': notImplemented('vnc.open'),
  },
};
