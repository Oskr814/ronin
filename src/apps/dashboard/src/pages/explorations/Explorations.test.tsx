// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostContext, type ExplorationsView } from '../../host.js';
import { testHost } from '../../test-host.js';
import { Exploration } from './Exploration.js';
import { Explorations } from './Explorations.js';
import { ExploreNow } from './ExploreNow.js';

// Invented apps: one with its exploration PR and findings to decide on, one
// being explored now with no PR yet.
const at = '2026-10-15T12:00:00Z';
const VIEW: ExplorationsView = {
  rows: [
    { repo: 'acme/tienda', app: 'backoffice', pr: { number: 12, id: 'acme/tienda#12', title: 'Exploración de backoffice' }, running: null },
    { repo: 'acme/tienda', app: 'web', pr: null, running: { since: at, step: 'abriendo el carrito', fn: 'carrito' } },
  ],
  list: [
    { repo: 'acme/tienda', app: 'backoffice', pr: null, running: null, lastRun: { at, state: 'ok' }, next: null, fichas: { total: 4, decidir: 2, esperando: 0, aprobadas: 2, rechazadas: 0 } as never },
  ],
  error: null,
  launched: {},
};
const RUNS = {
  corridas: [{
    id: 'c1', trigger: { kind: 'manual', by: 'ana-dev' }, startedAt: at, endedAt: '2026-10-15T12:40:00Z', state: 'ok', costUsd: 1.5, seed: 7,
    functions: [{ id: 'carrito', status: 'ok', charter: 'pagar', viewports: ['móvil'] }, { id: 'login', status: 'fallo', error: 'no cargó' }],
    findings: [{ id: 'F-0001' }], agents: [{ runId: 'r1', taskType: 'explore-function', fn: 'carrito', state: 'ok', startedAt: at, durationMs: 600_000 }],
  }],
};
const INVENTORY = {
  from: { branch: 'main' }, charters: ['pagar', 'buscar'],
  funciones: [
    { id: 'carrito', nombre: 'Carrito', rutas: ['/carrito'], prioridad: 'alta', charters: { pagar: '2026-10-10' }, viewports: ['móvil'], ultima: '2026-10-10', hallazgos: 2 },
    { id: 'perfil', nombre: 'Perfil', rutas: [], prioridad: 'normal', charters: {}, viewports: [], hallazgos: 0 },
  ],
};

const calls: Array<{ method: string; path: string; body: unknown }> = [];
let answer = (_path: string): unknown => ({});
beforeEach(() => {
  calls.length = 0;
  answer = (path) => (path.endsWith('/runs') ? RUNS : path.endsWith('/inventory') ? INVENTORY : path === '/api/runs/r1' ? { summary: { runId: 'r1', taskType: 'explore-function', state: 'ok', startedAt: at, durationMs: 600_000 }, lines: [{ type: 'text', text: 'Abrí el carrito.' }] } : path.endsWith('/run') ? { until: '2026-10-15T14:00:00Z' } : {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input), 'http://x').pathname);
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = answer(path);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (page: ReactNode, host = testHost({ explorations: () => VIEW })) => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HostContext.Provider value={host}>{page}</HostContext.Provider>
    </QueryClientProvider>,
  );
  return host;
};

describe('Exploraciones', () => {
  it('lists the apps with their state, and opens one', () => {
    const host = show(<Explorations />);
    expect(screen.getByText('2 fichas por decidir')).toBeTruthy();
    expect(screen.getByText('explorando carrito')).toBeTruthy();
    expect(screen.getByText('abriendo el carrito')).toBeTruthy();
    expect(screen.getByText('se abre con la primera ficha')).toBeTruthy();
    fireEvent.click(screen.getByText('web'));
    expect(host.openExploration).toHaveBeenCalledWith('acme/tienda', 'web');
  });

  it('shows an app with no PR, its runs and an agent\'s transcript', async () => {
    show(<Exploration repo="acme/tienda" app="web" />);
    expect(screen.getByText('Sin PR de exploración')).toBeTruthy();
    expect((screen.getByText('Explorar ahora') as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText('a pedido de ana-dev');
    expect(screen.getByText('1 ficha: F-0001')).toBeTruthy();
    expect(screen.getByText('semilla 7')).toBeTruthy();
    expect(screen.getByText('login').getAttribute('title')).toBe('fallo · no cargó');
    expect(calls[0].path).toBe('/api/explorations/acme/tienda/web/runs');
    fireEvent.click(screen.getByText('explore-function carrito'));
    await screen.findByText('Abrí el carrito.');
    fireEvent.click(screen.getByText('Cerrar'));
    expect(screen.queryByText('Abrí el carrito.')).toBeNull();
  });

  it('shows the inventory', async () => {
    show(<Exploration repo="acme/tienda" app="web" />);
    fireEvent.click(screen.getByText('Inventario'));
    await screen.findByText('Carrito');
    expect(screen.getByText(/1 de 2 funciones exploradas/)).toBeTruthy();
    expect(screen.getByText('alta')).toBeTruthy();
    expect(screen.getByText('nunca explorada')).toBeTruthy();
    expect(calls.at(-1)?.path).toBe('/api/explorations/acme/tienda/web/inventory');
  });

  it('says so when no repo explores the app', () => {
    show(<Exploration repo="acme/tienda" app="otra" />);
    expect(screen.getByText('Ningún repo de ronin explora la app otra.')).toBeTruthy();
  });
});

describe('Explorar ahora', () => {
  it('sends what was chosen, and says it went', async () => {
    const onClose = vi.fn();
    const host = show(<ExploreNow repo="acme/tienda" app="backoffice" onClose={onClose} />);
    expect(screen.getByText(/Lo que encuentre se suma al PR #12/)).toBeTruthy();
    fireEvent.change(document.getElementById('xn-n')!, { target: { value: '5' } });
    fireEvent.change(document.getElementById('xn-h')!, { target: { value: '' } });
    fireEvent.click(document.getElementById('xn-night')!);
    expect(screen.getByText('Esta noche corre otra igual, con otras funciones.')).toBeTruthy();
    fireEvent.click(screen.getByText('Explorar'));
    await waitFor(() => expect(host.explored).toHaveBeenCalledWith('acme/tienda', 'backoffice'));
    expect(calls).toEqual([{ method: 'POST', path: '/api/explorations/acme/tienda/backoffice/run', body: { maxFunctions: 5, hours: null, tonight: false } }]);
    expect(host.toast).toHaveBeenCalledWith(expect.stringMatching(/^ronin está levantando backoffice para explorarla hasta las .*\. La corrida se sigue en Corridas\.$/));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says why it couldn\'t, and closes with Escape', async () => {
    answer = () => new Response(JSON.stringify({ error: 'ya hay una corriendo' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    const onClose = vi.fn();
    show(<ExploreNow repo="acme/tienda" app="web" onClose={onClose} />);
    fireEvent.click(screen.getByText('Explorar'));
    await screen.findByText('No se pudo: ya hay una corriendo');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
