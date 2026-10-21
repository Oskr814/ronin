import { createContext, useContext } from 'react';
import type { ExplorationListRow, ExplorationRow } from '../../../domains/explorations/board.js';
import type { LinearPlanning } from '../../../platform/linear/linear-api.js';
import type { Snapshot } from './api.js';

export type { ExplorationListRow, ExplorationRow, LinearPlanning };

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
  // Opens the portal's requests.
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
  // Reuniones (#62): the list, or a meeting's page.
  openMeetings(): void;
  openMeeting(n: number): void;
  // What the session can do in a repo (notas, aprobar, acciones, desplegar).
  can(repo: string, perm: string): boolean;
  // The session's GitHub login.
  me(): string;
  // What a repo's Linear team offers to plan with, if it has one.
  planning(repo: string): LinearPlanning | null;
  // Markdown as clean HTML (app.js's md), its #123 linked to the repo.
  markdown(text: string, repo: string): string;
  // Whether the sidebar has an item: a #123 opens it here, not on GitHub.
  hasItem(key: string): boolean;
  // Reads the snapshot again (the sidebar's counts).
  refresh(): void;
  // The snapshot as the shell last read it (the sidebar's items, the
  // previews, the repos).
  snapshot(): Snapshot;
  // The sidebar's Linear project, '' for all of them, and choosing another.
  project(): string;
  setProject(id: string): void;
  // A Linear project's color, the same everywhere on the page.
  projectColor(id: string): string;
  // Opens an item on one of its runs.
  openRun(key: string, runId: string): void;
  // Exploraciones (#155): the apps the repos explore, as the snapshot and
  // the list app.js reads for the sidebar have them. The same object until
  // either changes; `subscribe` says when.
  explorations(): ExplorationsView;
  // Opens the list of the apps, or an app's page (its exploration PR's when
  // it has one).
  openExplorations(): void;
  openExploration(repo: string, app: string): void;
  // Opens Explorar ahora for an app (the dialog is a page app.js mounts on
  // its own: the item's head opens it too); `explored`, that it went: the
  // dialog closes and the app shows as starting.
  exploreNow(repo: string, app: string): void;
  explored(repo: string, app: string): void;
  // A call each time the shell draws again (a new snapshot, another project
  // in the sidebar) or the explorations change. Returns how to stop.
  subscribe(onChange: () => void): () => void;
}

export interface ExplorationsView {
  rows: ExplorationRow[];
  // What /api/explorations adds to each row, once read, or why it couldn't be.
  list: ExplorationListRow[] | null;
  error: string | null;
  // The apps launched from here, by repo, until the snapshot sees them.
  launched: Record<string, { app: string; at: number }>;
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
