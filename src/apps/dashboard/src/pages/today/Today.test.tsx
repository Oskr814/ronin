// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../api.js';
import { HostContext, type Host } from '../../host.js';
import { testHost } from '../../test-host.js';
import { Today } from './Today.js';

// Invented data: two repos, a day of runs, a Linear cycle each.
const DATA = JSON.parse(readFileSync(join(import.meta.dirname, 'fixture.test.json'), 'utf8'));

let today: unknown;
const asked: string[] = [];
beforeEach(() => {
  asked.length = 0;
  today = DATA.today;
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(DATA.now) });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x');
    asked.push(url.pathname);
    return new Response(JSON.stringify(today), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function show(overrides: Partial<Host> = {}) {
  const listeners = new Set<() => void>();
  let snap: Snapshot = DATA.snapshot;
  let project = '';
  const host = testHost({
    snapshot: () => snap,
    subscribe: (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    project: () => project,
    ...overrides,
  });
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HostContext.Provider value={host}>
        <Today />
      </HostContext.Provider>
    </QueryClientProvider>,
  );
  // The shell draws again: another snapshot, another project in the sidebar.
  const shell = (next: { snap?: Snapshot; project?: string }) => act(() => {
    snap = next.snap ?? snap;
    project = next.project ?? project;
    for (const f of listeners) f();
  });
  return { ...view, host, shell };
}

describe('Hoy, in React', () => {
  it('draws the day, what waits on a person, the cycles and the runs', async () => {
    const { container, host } = show();
    expect(screen.getByText('Cargando…')).toBeTruthy();
    await waitFor(() => expect(container.querySelector('.tiles')).not.toBeNull());
    expect(asked).toEqual(['/api/today']);
    expect(container.querySelector('.lead')?.textContent).toBe('Miércoles, 21 de octubre · 1 agente trabajando, 1 issue espera una respuesta, 5 PRs esperan tu review o tu merge.');
    expect([...container.querySelectorAll('.tile .v')].map((e) => e.textContent)).toEqual(['11', '80%', '16 min', 'US$4,25']);
    expect(container.querySelectorAll('.tile')[3].querySelector('.d')?.textContent).toBe('ayer US$3,90, 3 con error, 1 sin cuota');
    // Four of ronin's five PRs, the one that waits longest first.
    expect(container.querySelectorAll('.att .arow')).toHaveLength(1 + 4 + 1 + 2);
    expect(container.querySelectorAll('.att .arow')[1].querySelector('.t')?.textContent).toBe('Cambio número 54 que espera una review');
    expect(container.querySelectorAll('.rcol .burn')).toHaveLength(2);
    expect(container.querySelectorAll('.lane')).toHaveLength(2);
    expect(container.querySelectorAll('.bar.fail')).toHaveLength(3);
  });

  it('opens an item, a run, all of ronin PRs, and filters by a project', async () => {
    const { container, host } = show();
    await waitFor(() => expect(container.querySelector('.tiles')).not.toBeNull());
    fireEvent.click(screen.getByText('El pie de página se corta en el teléfono'));
    expect(host.openItem).toHaveBeenCalledWith('acme/tienda#42');
    fireEvent.click(screen.getByText('Ver los 5 →'));
    expect(container.querySelectorAll('.att .arow')).toHaveLength(1 + 5 + 1 + 2);
    fireEvent.click(container.querySelector('.bar.live')!);
    expect(host.openRun).toHaveBeenCalledWith('acme/tienda#41', expect.stringMatching(/^r-acme\/tienda-41-/));
    fireEvent.click(screen.getByRole('button', { name: /Checkout/ }));
    expect(host.setProject).toHaveBeenCalledWith('p1');
  });

  it('draws again when the shell does', async () => {
    const { container, shell } = show();
    await waitFor(() => expect(container.querySelector('.tiles')).not.toBeNull());
    shell({ project: 'p1' });
    expect(screen.getByRole('button', { name: /Checkout/ }).getAttribute('aria-pressed')).toBe('true');
    shell({ snap: DATA.emptySnap });
    expect(container.querySelector('.lead')?.textContent).toContain('ningún agente trabajando.');
    expect(container.querySelector('.card h2 .c')?.textContent).toBe('nada');
  });

  it('shows a cycle day under the pointer', async () => {
    const { container } = show();
    await waitFor(() => expect(container.querySelector('.burn')).not.toBeNull());
    const burn = container.querySelector('.burn')!;
    burn.querySelector('svg')!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 180, right: 400, bottom: 180, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerMove(burn.querySelector('.hit')!, { clientX: 28 });
    expect(burn.querySelector('.btip')?.textContent).toBe('13 oct10 en el ciclo0 hechos');
    expect(burn.querySelector<HTMLElement>('.btip')!.hidden).toBe(false);
    fireEvent.pointerLeave(burn.querySelector('.hit')!);
    expect(burn.querySelector<HTMLElement>('.btip')!.hidden).toBe(true);
  });

  it('says when there is nothing', async () => {
    today = DATA.empty;
    const { container } = show({ snapshot: () => DATA.emptySnap });
    await waitFor(() => expect(container.querySelector('.tiles')).not.toBeNull());
    expect(container.querySelector('.hgrid.one')).not.toBeNull();
    expect(screen.getByText('Ninguna corrida de agentes en las últimas 12 horas.')).toBeTruthy();
    expect(screen.getAllByText('Ninguno.')).toHaveLength(2);
  });
});
