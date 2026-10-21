// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Despliegues } from './Despliegues.js';
import { HostContext, type Host } from './host.js';

const change = (sha: string, subject: string, pr: number | null, pedidos: number[] = []) => ({ sha, subject, pr, apps: [], pedidos });
const REPOS = [{
  repo: 'acme/tienda', branch: 'main', prerelease: false, selective: true,
  pending: { base: 'v1.4.0', head: 'h', changes: [change('a1', 'Mostrar el teléfono (#41)', 41, [7]), change('b2', 'Corregir el pie (#42)', 42)] },
  releases: [{ tag: 'v1.4.0', name: 'v1.4.0', at: '2026-10-20T00:00:00Z', prerelease: false, latest: true, url: '', deploy: { state: 'deployed', mode: 'all', by: 'persona', at: '2026-10-20T00:00:00Z', pedidos: [], changes: 2, runs: [] } }],
}];
const plan = (prs: number[]) => ({
  tag: 'v1.5.0', prerelease: false, mode: 'pick', base: 'v1.4.0', target: prs.includes(42) ? null : 'f', apps: [], notes: 'notas',
  changes: REPOS[0].pending.changes.filter((c) => prs.includes(c.pr!)),
  problems: prs.includes(42) ? [{ kind: 'conflict', pr: 42, sha: 'b2', files: ['pie.tsx'], needs: [] }] : [],
  messages: prs.includes(42) ? ['#42 choca'] : [], fingerprint: `fp-${prs.join('-')}`,
});

const calls: Array<{ path: string; body: any }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/despliegues') return json({ repos: REPOS });
    if (path.endsWith('/plan')) return json(plan(body.prs));
    if (path.endsWith('/publish')) return json({ tag: body.tag, url: '', pedidos: [7] });
    return json({});
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const host: Host = { toast: vi.fn(), openPedido: vi.fn(), unauthorized: vi.fn(), repoColor: () => 'red', read: vi.fn() };
const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <HostContext.Provider value={host}><Despliegues /></HostContext.Provider>
  </QueryClientProvider>,
);

describe('Despliegues, in React', () => {
  it('lists what is pending and the releases, and opens the request a change came from', async () => {
    show();
    expect(await screen.findByText('acme/tienda')).toBeTruthy();
    expect(screen.getByText('2 cambios')).toBeTruthy();
    expect(screen.getByText('desplegado')).toBeTruthy();
    fireEvent.click(screen.getByText('del pedido P-7'));
    expect(host.openPedido).toHaveBeenCalledWith(7);
    await waitFor(() => expect(host.read).toHaveBeenCalledWith('despliegues', REPOS));
  });

  it('plans while the tag is written, shows what clashes, and publishes what it showed', async () => {
    show();
    fireEvent.click((await screen.findAllByText('Desplegar solo este'))[0]);
    fireEvent.change(screen.getByPlaceholderText('v1.4.0'), { target: { value: 'v1.5.0' } });
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/plan'))).toBe(true));
    expect(await screen.findByText(/se aplica limpio sobre v1.4.0/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: /#42/ }));
    expect(await screen.findByText(/#42 no se aplica limpio/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Publicar y desplegar/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: /#42/ }));
    await screen.findByText(/se aplica limpio/);
    fireEvent.click(screen.getByRole('button', { name: 'Publicar y desplegar' }));
    await waitFor(() => expect(host.toast).toHaveBeenCalled());
    expect(calls.find((c) => c.path.endsWith('/publish'))?.body).toMatchObject({ tag: 'v1.5.0', prs: [41], fingerprint: 'fp-41' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
