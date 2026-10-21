// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fresh each test: the version the page saw first is module state.
let api: typeof import('./api.js');
const reload = vi.fn();
let version = 'v1';
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Portal-Version': version } }));

beforeEach(async () => {
  vi.resetModules();
  version = 'v1';
  fetchMock.mockClear();
  reload.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { ...location, reload });
  api = await import('./api.js');
});
afterEach(() => vi.unstubAllGlobals());

const sent = (i = 0) => {
  const [input, init] = fetchMock.mock.calls[i];
  return { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body };
};

describe('the API client', () => {
  it('sends every change as JSON, even one with nothing to say, which the server takes no other way', async () => {
    await api.ok(api.client.login.$post({ json: { email: 'persona@gmail.com', password: 'x' } }));
    expect(sent(0)).toMatchObject({ url: '/api/portal/login', method: 'POST' });
    expect(sent(0).headers.get('content-type')).toBe('application/json');
    await api.ok(api.client.requests[':n'].cancel.$post({ param: { n: '3' } }));
    expect(sent(1)).toMatchObject({ url: '/api/portal/requests/3/cancel', method: 'POST', body: '{}' });
    expect(sent(1).headers.get('content-type')).toBe('application/json');
    await api.ok(api.client.me.$get());
    expect(sent(2).body).toBeUndefined();
  });

  it('turns an error answer into what the server said, and a 401 into the end of the session', async () => {
    const out = vi.fn();
    api.setUnauthorized(out);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'No existe ese pedido.' }), { status: 404 }));
    const error = await api.ok(api.client.requests[':n'].$get({ param: { n: '9' } })).catch((e) => e);
    expect(error).toMatchObject({ message: 'No existe ese pedido.', status: 404 });
    expect(api.ended(error)).toBe(false);
    expect(api.ended(new api.ApiError('sin sesión', 401))).toBe(true);
    expect(out).toHaveBeenCalledOnce();
  });

  it('after a deploy, reloads the page if the person is not in the middle of something, or says so', async () => {
    let busy = false;
    api.setIdleCheck(() => !busy);
    const stale = vi.fn();
    api.onStale(stale);
    await api.ok(api.client.me.$get());
    version = 'v2';
    busy = true;
    await api.ok(api.client.me.$get());
    expect(reload).not.toHaveBeenCalled();
    expect(api.isStale()).toBe(true);
    expect(stale).toHaveBeenCalledOnce();
    busy = false;
    await api.ok(api.client.me.$get());
    expect(reload).toHaveBeenCalledOnce();
  });
});
