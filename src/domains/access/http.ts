import type { HttpBindings } from '@hono/node-server';
import type { Access } from './access.js';

// Who's asking the dashboard: whoever logged in with GitHub (apps/api/http/auth.ts)
// and the repos they see, already checked by the tailnet listener.

export interface Session {
  login: string;
  // The GitHub token of whoever logged in, to act on GitHub as them.
  token: string;
}

// What the dashboard's route groups find in c.env, next to the Node request.
export type DashboardBindings = HttpBindings & { session: Session; access: Access };
export type DashboardEnv = { Bindings: DashboardBindings };
