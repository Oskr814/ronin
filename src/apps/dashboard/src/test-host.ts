import { vi } from 'vitest';
import type { Host } from './host.js';

// A Host for the pages' tests: every call recorded, and an answer where a
// test needs one in particular.
export function testHost(overrides: Partial<Host> = {}): Host {
  return {
    toast: vi.fn(),
    openPedido: vi.fn(),
    openPedidos: vi.fn(),
    unauthorized: vi.fn(),
    repoColor: () => 'red',
    read: vi.fn(),
    openItem: vi.fn(),
    openSettings: vi.fn(),
    openMetrics: vi.fn(),
    settingsView: () => ({ section: 'perfil', login: null, repo: null, account: null, filter: null }),
    session: () => ({ me: 'ana-dev', portalAdmin: false }),
    setTheme: vi.fn(),
    repos: () => ['acme/tienda'],
    typeName: (type) => type,
    requestsTotal: () => 0,
    portalAdmin: () => false,
    openPortalAccounts: vi.fn(),
    requestDoc: () => () => {},
    openMeetings: vi.fn(),
    openMeeting: vi.fn(),
    can: () => true,
    me: () => 'ana-dev',
    planning: () => null,
    markdown: (text) => text,
    hasItem: () => false,
    refresh: vi.fn(),
    snapshot: () => { throw new Error('sin snapshot'); },
    subscribe: () => () => {},
    project: () => '',
    setProject: vi.fn(),
    projectColor: () => 'var(--proj-0)',
    openRun: vi.fn(),
    explorations: () => ({ rows: [], list: null, error: null, launched: {} }),
    openExplorations: vi.fn(),
    openExploration: vi.fn(),
    exploreNow: vi.fn(),
    explored: vi.fn(),
    ...overrides,
  };
}
