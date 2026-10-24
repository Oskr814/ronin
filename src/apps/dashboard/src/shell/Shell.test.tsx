// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Invented data: two repos, an issue ronin works on, one that waits on a
// person, a PR of ronin's waiting on a decision, a queue and Linear.
const NOW = Date.parse('2026-10-21T15:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60e3).toISOString();
const run = (runId: string, state: string, minAgo: number) => ({ runId, repo: 'acme/tienda', taskType: 'fix-issue', label: 'fix-issue', account: 'cuenta-a', worktree: `/w/${runId}`, startedAt: iso(minAgo), state, steps: 3 });
const ITEMS = [
  { id: 'acme/tienda#1', repo: 'acme/tienda', number: 1, kind: 'issue', title: 'El total no suma el envío', status: 'running', github: 'open', runs: 1, listed: true, lastRun: run('r1', 'running', 3) },
  { id: 'acme/tienda#2', repo: 'acme/tienda', number: 2, kind: 'issue', title: 'Cobrar en cuotas', status: 'blocked', github: 'open', runs: 1, listed: true, block: { at: iso(60), reason: 'Necesito saber cuántas cuotas' }, lastRun: run('r2', 'ok', 70),
    linear: { id: 'TND-2', url: 'https://linear.app/acme/issue/TND-2', state: { name: 'Bloqueado' }, project: { id: 'p1', name: 'Pagos' }, cycle: { name: '', number: 7, current: true } } },
  { id: 'acme/web#3', repo: 'acme/web', number: 3, kind: 'issue', title: 'El menú no cierra', status: 'waiting', github: 'open', runs: 0, listed: true, pr: { number: 4, author: 'ronin-bot', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', checks: [] } },
];
const SNAP = {
  me: 'ana-dev', access: { admin: true, repos: [] }, ronin: 'ronin-bot', portalAdmin: true, pedidos: [], pedidosTotal: 0, reunionesPorRevisar: 0, repos: ['acme/tienda', 'acme/web'],
  runner: { slots: { used: 1, limit: 4, repos: [] }, queue: [{ label: 'tick', since: iso(1) }, { label: 'fix-issue', repo: 'acme/web', since: iso(2) }], tick: {}, host: null },
  usage: [], items: ITEMS, despliegues: true, exploraciones: [{ repo: 'acme/web', app: 'backoffice', pr: null, running: null }], previews: [], github: [{ repo: 'acme/tienda', fetchedAt: iso(1) }, { repo: 'acme/web', fetchedAt: iso(1) }],
  apps: { 'acme/tienda': ['tienda'], 'acme/web': [] },
  linear: [{ repo: 'acme/tienda', fetchedAt: iso(1), cycle: { team: 'TND', number: 7, startsAt: iso(5000), endsAt: iso(-5000) }, planning: { projects: [{ id: 'p1', name: 'Pagos' }], cycles: [{ id: 'c7', number: 7, current: true, startsAt: iso(5000), endsAt: iso(-5000) }] } }],
};

let snap: Record<string, unknown>;
const posts: Array<{ path: string; body: string | undefined }> = [];
beforeEach(() => {
  vi.resetModules();
  snap = SNAP;
  posts.length = 0;
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('EventSource', class { close() {} addEventListener() {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (init?.method === 'POST') {
      posts.push({ path, body: init.body as string | undefined });
      return json({ id: 'acme/tienda#9', number: 9, url: 'https://github.com/acme/tienda/issues/9' });
    }
    if (path === '/api/snapshot') return json(snap);
    if (/^\/api\/items\/[^/]+$/.test(path)) return json({ runs: [] });
    return json({});
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The dashboard at a path, as the browser opens it.
async function open(path: string) {
  history.replaceState(null, '', path);
  const { Shell } = await import('./Shell.js');
  const { queryClient } = await import('./state.js');
  const view = render(<QueryClientProvider client={queryClient}><Shell /></QueryClientProvider>);
  await waitFor(() => expect(view.container.querySelector('#shell:not([hidden])')).not.toBeNull());
  return view;
}
const page = () => document.querySelector('.react-page')?.getAttribute('data-page');

describe('the shell, in React', () => {
  it('routes each path to its page, as app.js did', async () => {
    const routes: Array<[string, string, string]> = [
      ['/', 'today', '/'],
      ['/pedidos', 'requests', '/pedidos'],
      ['/pedidos/7', 'request', '/pedidos/7'],
      ['/reuniones', 'meetings', '/reuniones'],
      ['/reuniones/3', 'meeting', '/reuniones/3'],
      ['/despliegues', 'deploys', '/despliegues'],
      ['/metricas', 'metrics', '/metricas'],
      ['/metricas/pedidos', 'requestMetrics', '/metricas/pedidos'],
      ['/metricas/suscripcion', 'subscription', '/metricas/suscripcion'],
      ['/exploraciones', 'explorations', '/exploraciones'],
      ['/exploraciones/acme/web/backoffice', 'exploration', '/exploraciones/acme/web/backoffice'],
      ['/ajustes', 'settings', '/ajustes/perfil'],
      ['/ajustes/repos/acme/web', 'settings', '/ajustes/repos/acme/web'],
      ['/portal', 'settings', '/ajustes/usuarios'],
      ['/acme/tienda/issues/1', 'item', '/acme/tienda/issues/1'],
      // A PR the sidebar doesn't have stays a PR.
      ['/acme/web/pull/5', 'item', '/acme/web/pull/5'],
      // A link from before: it opens, and the address bar takes the path it has now.
      ['/i/acme%2Ftienda%231', 'item', '/acme/tienda/issues/1'],
      ['/no-existe', 'today', '/no-existe'],
    ];
    for (const [path, name, to] of routes) {
      await open(path);
      expect([path, page()]).toEqual([path, name]);
      expect(location.pathname).toBe(to);
      cleanup();
      vi.resetModules();
    }
  });

  it('keeps an admin page for admins', async () => {
    snap = { ...SNAP, access: { admin: false, repos: [{ repo: 'acme/tienda', permission: 'push' }] }, despliegues: false };
    await open('/metricas');
    expect(page()).toBe('today');
  });

  it('counts and filters the sidebar, and opens an issue by its number', async () => {
    const { container } = await open('/');
    expect(screen.getByText('Corriendo ahora').querySelector('.c')?.textContent).toBe('1');
    expect(screen.getByText('En cola').querySelector('.c')?.textContent).toBe('2');
    expect(container.querySelectorAll('.tree .item[data-id]')).toHaveLength(3);
    // The blocked one in its repo, in its place, with its red dot: no group of its own.
    expect([...container.querySelectorAll('.tree .grp')].map((g) => g.textContent)).not.toContain('Necesitan a alguien1');
    expect(container.querySelector('.item[data-id="acme/tienda#2"] .dot')?.className).toContain('crit');
    expect([...container.querySelectorAll('.tree .item[data-id^="acme/tienda"]')].map((b) => b.getAttribute('data-id'))).toEqual(['acme/tienda#1', 'acme/tienda#2']);
    fireEvent.click(screen.getByText('Corriendo ahora'));
    expect([...container.querySelectorAll('.tree .item[data-id]')].map((b) => b.getAttribute('data-id'))).toEqual(['acme/tienda#1']);
    fireEvent.click(screen.getByText('En cola'));
    expect(container.querySelectorAll('.queue-row')).toHaveLength(2);
    fireEvent.click(screen.getByText('En cola'));
    fireEvent.change(container.querySelector('#proj')!, { target: { value: 'p1' } });
    expect([...container.querySelectorAll('.tree .item[data-id]')].map((b) => b.getAttribute('data-id'))).toEqual(['acme/tienda#2']);
    expect(localStorage.getItem('ronin-scope')).toBe('{"scope":"all","project":"p1"}');
    fireEvent.change(container.querySelector('#proj')!, { target: { value: '' } });
    fireEvent.change(container.querySelector('#q')!, { target: { value: '#77' } });
    fireEvent.click(container.querySelectorAll('.open-n')[1]);
    await waitFor(() => expect(location.pathname).toBe('/acme/web/issues/77'));
    expect(page()).toBe('item');
  });

  it("marks an issue that came from a portal request, and lists no request on its own", async () => {
    const pedido = (number: number, issue?: number) => ({ number, repo: 'acme/tienda', title: `Pedido ${number}`, status: 'fixing', waitsOn: 'ronin', running: false, person: 'Eva Ficticia', lastAt: iso(5), ...(issue ? { issue } : {}) });
    snap = { ...SNAP, pedidos: [pedido(7, 2), pedido(8)], pedidosTotal: 2 };
    const { container } = await open('/');
    expect(container.querySelector('.item[data-id="acme/tienda#2"] .pd-pn')?.textContent).toBe('P-7');
    expect(container.querySelector('.item[data-id="acme/tienda#1"] .pd-pn')).toBeNull();
    expect(container.querySelector('.tree [data-ped]')).toBeNull();
    expect(container.querySelector('.tree')?.textContent).not.toContain('Pedido 8');
  });

  it('shows the runner with no item open, and the item around its page', async () => {
    const { container } = await open('/');
    expect(container.querySelector('#ctx h3')?.textContent).toBe('Tu acceso');
    expect(container.querySelector('#ctx')?.textContent).toContain('1 de 4 lugares ocupados');
    fireEvent.click(container.querySelector('.item[data-id="acme/tienda#2"]')!);
    await waitFor(() => expect(page()).toBe('item'));
    const ctx = container.querySelector('#ctx')!;
    expect(ctx.querySelector('.why')?.textContent).toContain('Hace 1h. Necesito saber cuántas cuotas');
    expect(ctx.textContent).toContain('TND-2 ↗');
    // The tabs of the items open, and closing the last one goes home.
    expect([...container.querySelectorAll('.tab .l')].map((t) => t.textContent)).toEqual(['El total no suma el envío', 'Cobrar en cuotas']);
    fireEvent.click(container.querySelectorAll('.tab .x')[1]);
    await waitFor(() => expect(location.pathname).toBe('/acme/tienda/issues/1'));
  });

  it('opens an item over the tab shown, unless it is pinned', async () => {
    const { container } = await open('/');
    const tabs = () => [...container.querySelectorAll('.tab .l')].map((t) => t.textContent);
    fireEvent.click(container.querySelector('.tab .open')!);
    await waitFor(() => expect(page()).toBe('item'));
    fireEvent.click(container.querySelector('.item[data-id="acme/tienda#2"]')!);
    await waitFor(() => expect(tabs()).toEqual(['Cobrar en cuotas']));
    fireEvent.click(container.querySelector('.tab .pin')!);
    expect(container.querySelector('.tab.pinned .pin')?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(container.querySelector('.item[data-id="acme/web#3"]')!);
    await waitFor(() => expect(tabs()).toEqual(['Cobrar en cuotas', 'El menú no cierra']));
  });

  it("opens an issue's PR as the issue, on the PR's tab", async () => {
    const { container } = await open('/acme/web/issues/3');
    await waitFor(() => expect(location.pathname).toBe('/acme/web/issues/3'));
    expect([...container.querySelectorAll('.tab .l')].map((t) => t.textContent)).toEqual(['El total no suma el envío', 'El menú no cierra']);
  });

  it("opens a slice's PR on its own page, merged or moving the issue", async () => {
    const slices = [{ index: 0, title: 'Columnas', prNumber: 5, status: 'merged' }, { index: 1, title: 'Endpoint', prNumber: 4, status: 'open' }, { index: 2, title: 'Pestaña', prNumber: null, status: 'pending' }];
    snap = { ...SNAP, items: ITEMS.map((item) => (item.id === 'acme/web#3' ? { ...item, slices } : item)) };
    const { container } = await open('/acme/web/issues/3');
    const kid = (n: number) => [...container.querySelectorAll('.kid')].find((k) => k.textContent?.endsWith(`#${n}`))!;
    fireEvent.click(kid(5));
    await waitFor(() => expect(location.pathname).toBe('/acme/web/pull/5'));
    expect(kid(5).getAttribute('aria-current')).toBe('true');
    fireEvent.click(kid(4));
    await waitFor(() => expect(location.pathname).toBe('/acme/web/pull/4'));
    expect([...container.querySelectorAll('.tab .l')].map((t) => t.textContent).at(-1)).toBe('#4');
  });

  it('goes to the next PR that waits on a decision with ]p', async () => {
    await open('/');
    fireEvent.keyDown(document, { key: ']' });
    fireEvent.keyDown(document, { key: 'p' });
    await waitFor(() => expect(location.pathname).toBe('/acme/web/issues/3'));
  });

  it('creates an issue with the same body app.js sent', async () => {
    const { container } = await open('/');
    fireEvent.click(container.querySelector('[data-new="acme/tienda"]')!);
    fireEvent.change(container.ownerDocument.getElementById('ni-title')!, { target: { value: 'El cupón no se aplica' } });
    fireEvent.change(container.ownerDocument.getElementById('ni-body')!, { target: { value: 'Pasos.' } });
    fireEvent.click(container.ownerDocument.querySelector('[name="ni-after"][value="spike"]')!);
    fireEvent.change(container.ownerDocument.getElementById('ni-instr')!, { target: { value: 'mirá   el carrito' } });
    fireEvent.change(container.ownerDocument.getElementById('ni-project')!, { target: { value: 'p1' } });
    expect(container.ownerDocument.getElementById('ni-line')?.textContent).toBe('@ronin-bot /spike tienda mirá el carrito');
    await act(async () => {
      fireEvent.click(container.ownerDocument.getElementById('ni-yes')!);
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: '/api/repos/acme/tienda/issues', body: '{"title":"El cupón no se aplica","body":"Pasos.","after":"spike","app":"tienda","instruction":"mirá   el carrito","projectId":"p1"}' });
    await waitFor(() => expect(container.ownerDocument.querySelector('.toast')?.textContent).toContain('Listo: creaste #9 y pediste /spike.'));
    await waitFor(() => expect(location.pathname).toBe('/acme/tienda/issues/9'));
  });

  it('goes to the login when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'sin sesión' }), { status: 401 })));
    history.replaceState(null, '', '/');
    const { Shell } = await import('./Shell.js');
    const { queryClient } = await import('./state.js');
    const { container } = render(<QueryClientProvider client={queryClient}><Shell /></QueryClientProvider>);
    await waitFor(() => expect(container.querySelector('#login:not([hidden])')).not.toBeNull());
    expect(container.querySelector('#shell')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('#login-why')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('#login a')?.getAttribute('href')).toBe('/api/auth/login?next=%2F');
  });

  it('keeps the notice to log in again over a dialog while reads as ronin go well, until its login is opened', async () => {
    await open('/acme/web/issues/3');
    const { api, showLogin, Unauthorized } = await import('./state.js');
    const scrim = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'scrim' }));
    act(() => { showLogin(new Unauthorized('Tu sesión de GitHub venció o se revocó. Volvé a entrar.')); });
    const link = () => document.querySelector<HTMLAnchorElement>('#relogin a');
    expect(link()?.getAttribute('href')).toBe('/api/auth/login?next=%2Facme%2Fweb%2Fissues%2F3');
    await act(async () => { await api('/api/snapshot'); });
    expect(link()).not.toBeNull();
    fireEvent.click(link()!);
    await act(async () => { await api('/api/snapshot'); });
    expect(link()).toBeNull();
    scrim.remove();
  });
});
