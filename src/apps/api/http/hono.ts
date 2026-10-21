import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';

// The API moved to Hono a group at a time (#235, stage 6), mounted inside
// the Node handlers of both listeners. What the route groups share is in
// platform/http/middleware.ts; the dashboard's session and access, in
// domains/access/http.ts.

// A Hono app answering one Node request, with `extra` next to it in c.env
// (the dashboard's session and access). Plain writeHead and end, which is
// all the dashboard's handlers (and their tests' stand-ins) need.
export async function answer<E extends object>(app: Hono<{ Bindings: HttpBindings & E }>, req: IncomingMessage, res: ServerResponse, extra: E): Promise<void> {
  const method = req.method ?? 'GET';
  const chunks: Buffer[] = [];
  if (method !== 'GET' && method !== 'HEAD') for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
  }
  const request = new Request(`http://localhost${req.url ?? '/'}`, { method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  const response = await app.fetch(request, { incoming: req, outgoing: res, ...extra });
  const out: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') out[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  // A stream of events (a run as it happens) goes out as it comes, until it
  // ends or the person leaves; anything else, whole.
  if (response.body && (response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    res.writeHead(response.status, out);
    const reader = response.body.getReader();
    req.on('close', () => void reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      res.write(value);
    }
    res.end();
    return;
  }
  res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
}
