// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostContext, type SettingsView } from '../../host.js';
import { testHost } from '../../test-host.js';
import { Settings } from './Settings.js';

// Invented data: a team at "acme" with two repos.
const setting = (key: string, value: number, extra = {}) => ({ key, env: key.toUpperCase().replace('.', '_'), type: 'int', value, source: 'defecto', base: value, baseSource: 'defecto', min: 0, max: 100, ...extra });
const notificaciones = [{ repo: 'acme/tienda', events: ['bloqueo'], chosen: true }, { repo: 'acme/web', events: [], chosen: false }];
const PAGE = {
  admin: {
    me: { login: 'ana-dev', admin: true }, perfil: { name: 'Ana Dev', email: 'persona@gmail.com' }, notificaciones, notifyTo: 'equipo@example.com', linear: [],
    valores: [setting('dashboard.sessionDays', 7), setting('dashboard.githubTtlSeconds', 60), setting('portal.dailyLimit', 8, { source: 'tablero', base: 5 }), setting('portal.sessionDays', 30)],
    tareas: [], fixed: { previewPortRange: '20000-20999', runnerId: 'runner-1', githubLogin: 'ronin-bot' }, portal: { url: 'https://portal.example.com' }, dashboard: { url: '' },
  },
  member: { me: { login: 'beto-qa', admin: false }, perfil: {}, notificaciones, linear: [] },
};
const USER = {
  login: 'beto-qa', name: 'Beto QA', email: 'otra@gmail.com', role: 'member', envAdmin: false, lastSeenAt: '2026-10-20T10:00:00Z', porDefecto: 'todo', entrada: 'github', notificaciones,
  repos: [{ repo: 'acme/tienda', github: 'write', githubLets: true, set: 'custom', hidden: false, perms: { notas: true, aprobar: false, acciones: true, desplegar: false } }],
};

let who: 'admin' | 'member' = 'admin';
const calls: Array<{ path: string; body: unknown }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === 'POST') calls.push({ path, body });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/settings') return json(PAGE[who]);
    if (path === '/api/settings/values') return json({ setting: { ...PAGE.admin.valores[2], value: body.value } });
    if (path === '/api/settings/users/beto-qa') return json(USER);
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (view: Partial<SettingsView>) => {
  const host = testHost({ repos: () => ['acme/tienda', 'acme/web'], settingsView: () => ({ section: 'perfil', login: null, repo: null, account: null, filter: null, ...view }), session: () => ({ me: 'ana-dev', portalAdmin: false }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HostContext.Provider value={host}><Settings /></HostContext.Provider>
    </QueryClientProvider>,
  );
  return host;
};

describe('Ajustes, in React', () => {
  it("shows a member their own profile, and their notifications off without an email", async () => {
    who = 'member';
    show({ section: 'perfil' });
    expect(await screen.findByText('Miembro')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Perfil' })).toBeTruthy();
    cleanup();
    show({ section: 'notificaciones' });
    expect(await screen.findByText('Sin correo.')).toBeTruthy();
    expect(screen.getAllByRole('switch').every((s) => (s as HTMLButtonElement).disabled)).toBe(true);
  });

  it('saves a value when its field is left, with the same body app.js sent', async () => {
    who = 'admin';
    const host = show({ section: 'general' });
    const input = await screen.findByLabelText('Pedidos por día');
    fireEvent.change(input, { target: { value: '9' } });
    await waitFor(() => expect(host.toast).toHaveBeenCalledWith('Guardado. Vale desde ahora.'));
    expect(calls).toEqual([{ path: '/api/settings/values', body: { key: 'portal.dailyLimit', value: 9 } }]);
    fireEvent.click(screen.getByText('Volver al de por defecto'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toEqual({ key: 'portal.dailyLimit', value: null });
  });

  it("shows one of the team, changes a permission and takes them off the list", async () => {
    who = 'admin';
    const host = show({ section: 'usuarios', login: 'beto-qa' });
    expect(await screen.findByRole('heading', { name: 'Beto QA' })).toBeTruthy();
    expect(screen.getByText('@beto-qa')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/^Aprobar/));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: '/api/settings/users/beto-qa', body: { repo: { repo: 'acme/tienda', custom: { notas: true, aprobar: true, acciones: true } } } });
    fireEvent.click(screen.getByText('Quitar de la lista'));
    await waitFor(() => expect(host.openSettings).toHaveBeenCalledWith('usuarios'));
    expect(calls[1].path).toBe('/api/settings/users/beto-qa/remove');
  });
});
