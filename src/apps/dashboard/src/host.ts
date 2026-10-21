import { createContext, useContext } from 'react';

// What a page asks of the shell around it (app.js), which mounts it.
export interface Host {
  // A note at the bottom, with a link to GitHub if there's one.
  toast(message: string, url?: string): void;
  // Opens a portal request's page, or the list of them.
  openPedido(n: number): void;
  openPedidos(): void;
  // The session ended: the page logs in again, or says so.
  unauthorized(message: string): void;
  // A repo's color in the sidebar.
  repoColor(repo: string): string;
  // What the page read, for what the sidebar shows of it.
  read?(name: string, data: unknown): void;
  // Opens an item (an issue or a PR) by its key, repo#number.
  openItem(key: string): void;
  // Opens a section of Ajustes (#174): in Usuarios, one of the team (in
  // Repos, a repo: owner/name), the list's filter, or one of the portal's
  // accounts. Or a tab of Métricas.
  openSettings(section: string, login?: string | null, filter?: string | null, account?: string | null): void;
  openMetrics(tab: 'trabajo' | 'suscripcion'): void;
  // What Ajustes shows, as app.js routed it (/ajustes/<sección>[/…]).
  settingsView(): SettingsView;
  // Who's looking, and whether they manage the portal's accounts.
  session(): { me: string; portalAdmin: boolean };
  // The theme, only in this browser.
  setTheme(theme: 'dark' | 'light'): void;
  // The repos the session sees, as the snapshot has them.
  repos(): string[];
  // A task type in words (fix-issue → "Arreglar un issue").
  typeName(type: string): string;
  // The portal's requests the snapshot counts, and whether the session
  // manages the portal's accounts, which are in Ajustes → Usuarios.
  requestsTotal(): number;
  portalAdmin(): boolean;
  openPortalAccounts(): void;
  // A request's issue or its PR, read as on its page (still app.js's): it
  // draws it into the element, again as GitHub's copy arrives, and wires its
  // buttons. Returns how to stop.
  requestDoc(element: HTMLElement, request: RequestDoc, onShow: (show: 'issue' | 'pr') => void): () => void;
}

export interface RequestDoc {
  repo: string;
  issue: number;
  pr: number | null;
  show: 'issue' | 'pr';
}

export interface SettingsView {
  section: string;
  login: string | null;
  repo: string | null;
  account: string | null;
  // Usuarios' filter, when one was asked for (todos, equipo, portal).
  filter: string | null;
}

export const HostContext = createContext<Host | null>(null);

export function useHost(): Host {
  const host = useContext(HostContext);
  if (!host) throw new Error('página fuera del tablero');
  return host;
}
