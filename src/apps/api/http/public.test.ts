import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicHandler } from './public.js';

const github = vi.fn(async (_req, res) => {
  res.writeHead(202).end();
});

let server: Server;
let base: string;

beforeAll(async () => {
  const handle = createPublicHandler(github);
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('public listener', () => {
  it("takes GitHub's deliveries on the new path and the old one", async () => {
    for (const path of ['/api/webhooks/github', '/webhook']) {
      github.mockClear();
      const res = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
      expect(res.status).toBe(202);
      expect(github).toHaveBeenCalledOnce();
    }
  });

  it('serves nothing else: the app and the rest of the API are only for the tailnet', async () => {
    github.mockClear();
    for (const [method, path] of [['GET', '/'], ['GET', '/api/snapshot'], ['POST', '/api/auth/login'], ['GET', '/api/webhooks/github'], ['POST', '/api/webhooks/github/x']]) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(github).not.toHaveBeenCalled();
  });

  it('ignores the query string when matching the path', async () => {
    github.mockClear();
    const res = await fetch(`${base}/api/webhooks/github?x=1`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(202);
  });

  it('with the request portal (#114), hands it every other path; the webhooks still go to GitHub', async () => {
    const portal = vi.fn(async (_req, res) => {
      res.writeHead(200).end('portal');
    });
    const handle = createPublicHandler(github, portal);
    const withPortal = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => withPortal.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(withPortal.address() as AddressInfo).port}`;
    try {
      github.mockClear();
      expect((await fetch(`${url}/api/webhooks/github`, { method: 'POST', body: '{}' })).status).toBe(202);
      expect(github).toHaveBeenCalledOnce();
      expect(await (await fetch(`${url}/`)).text()).toBe('portal');
      expect(await (await fetch(`${url}/api/portal/me`)).text()).toBe('portal');
      // A GET on the webhook path is neither GitHub's nor the portal's.
      expect((await fetch(`${url}/api/webhooks/github`)).status).toBe(404);
      expect(portal).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve) => withPortal.close(() => resolve()));
    }
  });
});
