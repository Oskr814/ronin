import { QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { Snapshot } from './api.js';
import { ShellContext, type ShellActions } from './shell/hooks.js';
import { queryClient, S, SNAPSHOT_KEY } from './shell/state.js';

// The shell around a page in its tests: what the page asks of it, recorded,
// and the cache it reads, with the snapshot the test gives it.

export function testShell(overrides: Partial<ShellActions> = {}): ShellActions {
  return {
    toast: vi.fn(),
    unauthorized: vi.fn(),
    openItem: vi.fn(),
    openRun: vi.fn(),
    openSettings: vi.fn(),
    openPortalAccounts: vi.fn(),
    openMetrics: vi.fn(),
    openRequest: vi.fn(),
    openRequests: vi.fn(),
    openMeetings: vi.fn(),
    openMeeting: vi.fn(),
    openExplorations: vi.fn(),
    openExploration: vi.fn(),
    exploreNow: vi.fn(),
    movePr: vi.fn(),
    keysHelp: vi.fn(),
    ...overrides,
  };
}

// An admin's snapshot of acme/tienda, with nothing going on.
export function testSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    me: 'ana-dev', ronin: 'ronin-bot', access: { admin: true, repos: [] }, portalAdmin: false, pedidos: [], pedidosTotal: 0, repos: ['acme/tienda'],
    items: [], previews: [], github: [], linear: [], exploraciones: [], usage: [], apps: {},
    ...over,
  } as unknown as Snapshot;
}

// A page as the shell mounts it, on the shell's cache with `snap` in it, and
// whatever else the test says was read (`data`).
export function showPage(page: ReactNode, { shell = testShell(), snap = testSnapshot(), data = [] }: { shell?: ShellActions; snap?: Snapshot; data?: Array<[QueryKey, unknown]> } = {}) {
  queryClient.setQueryData(SNAPSHOT_KEY, snap);
  for (const [key, value] of data) queryClient.setQueryData(key, value);
  const view = render(<QueryClientProvider client={queryClient}><ShellContext.Provider value={shell}>{page}</ShellContext.Provider></QueryClientProvider>);
  return { ...view, shell, qc: queryClient };
}

// What a test left in the shell, forgotten (afterEach).
export function resetShell() {
  queryClient.clear();
  Object.assign(S, {
    sel: null, open: [], runIdx: {}, pendingRun: null, view: {}, doc: {}, ficha: {}, fichaOpen: {}, extra: {}, revSent: {}, project: '',
    newIssue: null, xnow: null, toast: null, xpl: { repo: null, app: null, launched: {} },
  });
}
