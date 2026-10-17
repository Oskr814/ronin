import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGithubWebhook } from './api/webhooks/github.js';

// What the public listener serves: GitHub's webhook deliveries and, when
// it's configured, the request portal (#114, portal.ts). Everything else is
// a 404, whatever the proxy in front forwards — the dashboard and its API are
// only for the tailnet (#65).
//
// /webhook is the old path, kept until every repo's hook points at the new
// one (scripts/init-webhooks.sh moves them).
export const GITHUB_WEBHOOK_PATHS = ['/api/webhooks/github', '/webhook'];

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createPublicHandler(github: Handler = handleGithubWebhook, portal?: Handler): Handler {
  return async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'POST' && GITHUB_WEBHOOK_PATHS.includes(path)) {
      await github(req, res);
      return;
    }
    if (portal && !GITHUB_WEBHOOK_PATHS.includes(path)) {
      await portal(req, res);
      return;
    }
    res.writeHead(404).end();
  };
}
