/** `health.check`: running profiles, seats and docker state from the status providers. */
import type { HealthData } from '@threadline/shared';
import type { AgentModule } from '../registry';

export const healthModule: AgentModule = {
  name: 'health',
  handlers: {
    'health.check': async (_cmd, { status }) => {
      const data: HealthData = {
        running: status.running(),
        seats: status.seats(),
        docker: await status.docker(),
      };
      return { outcome: 'ok', data };
    },
  },
};
