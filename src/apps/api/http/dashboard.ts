import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Access } from '@domains/access/access.js';
import type { Session } from '@domains/access/http.js';
import { dashboardApp } from '../routes.js';
import { answer } from './hono.js';

// The dashboard's API (#65), all behind the session: tailnet.ts checks it,
// and the repos it sees (#106), before any of this runs. Every route is in
// Hono now (#235, stage 6), each group with its domain: server/
// apps/api/routes.ts mounts them. Always answers, a 404 for a path no group has.
export async function handleDashboard(req: IncomingMessage, res: ServerResponse, _path: string, session: Session, access: Access): Promise<boolean> {
  await answer(dashboardApp, req, res, { session, access });
  return true;
}
