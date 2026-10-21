import { createContext, useContext } from 'react';
import type { ExplorationListRow, ExplorationRow } from '../../../domains/explorations/board.js';
import type { LinearPlanning } from '../../../platform/linear/linear-api.js';
import type { ItemDetail, ItemRun, ShownRun, Snapshot } from './api.js';

export type { ExplorationListRow, ExplorationRow, LinearPlanning };

// What a page asks of the shell around it (shell/), which mounts it.
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
  // Opens an item (an issue or a PR) by its key, repo#number.
  openItem(key: string): void;
  // Opens a section of Ajustes (#174): in Usuarios, one of the team (in
  // Repos, a repo: owner/name), the list's filter, or one of the portal's
  // accounts. Or a tab of Métricas.
  openSettings(section: string, login?: string | null, filter?: string | null, account?: string | null): void;
  openMetrics(tab: 'trabajo' | 'suscripcion'): void;
  // What Ajustes shows, as the shell routed it (/ajustes/<sección>[/…]).
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
  // A request's issue or its PR (#158), read as on its page: the shell
  // reads it (and again once old) while the request's page shows it.
  // Returns how to stop.
  watchItem(key: string, kind: 'issue' | 'pr'): () => void;
  // Reuniones (#62): the list, or a meeting's page.
  openMeetings(): void;
  openMeeting(n: number): void;
  // What the session can do in a repo (notas, aprobar, acciones, desplegar).
  can(repo: string, perm: string): boolean;
  // The session's GitHub login.
  me(): string;
  // What a repo's Linear team offers to plan with, if it has one.
  planning(repo: string): LinearPlanning | null;
  // Markdown as clean HTML (lib/md.ts), its #123 linked to the repo.
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
  // the list the shell reads for the sidebar have them. The same object until
  // either changes; `subscribe` says when.
  explorations(): ExplorationsView;
  // Opens the list of the apps, or an app's page (its exploration PR's when
  // it has one).
  openExplorations(): void;
  openExploration(repo: string, app: string): void;
  // Opens Explorar ahora for an app (a dialog the shell opens on top: the
  // item's head opens it too); `explored`, that it went: the dialog closes
  // and the app shows as starting.
  exploreNow(repo: string, app: string): void;
  explored(repo: string, app: string): void;
  // A call each time the shell draws again (a new snapshot, another project
  // in the sidebar) or the explorations change. Returns how to stop.
  subscribe(onChange: () => void): () => void;

  // An item's page (#85, pages/item). The shell keeps what it reads of the
  // item, because its context column and the sidebar read it too: the
  // detail from GitHub, the runs, the run shown
  // (live while it goes) and which tab and run are shown. A new view each
  // time the shell draws (`subscribe`); null for an item it doesn't know.
  item(key: string): ItemView | null;
  // Shows one of the item's runs (its index in `runs`): on the page, or as
  // its transcript (`tx`). The shell reads it, and follows it while it goes.
  showRun(key: string, index: number, view: 'ficha' | 'tx'): void;
  // Shows a tab of the item's page.
  showDoc(key: string, tab: string): void;
  // Something was written on GitHub from the page: the item is read again,
  // and so is the snapshot.
  reread(key: string): void;
  // A review that approved or asked for changes shows on the PR's chips at
  // once, until the snapshot reads the repo again.
  reviewed(key: string, pr: number, decision: 'APPROVED' | 'CHANGES_REQUESTED'): void;
  // ]p and [p: the next or the previous PR of ronin's that waits on a
  // decision, in the sidebar's order.
  movePr(step: 1 | -1): void;
  // The keys' help (?), which the whole dashboard has.
  keysHelp(): void;
  // What the shell has open on top of the page (a dialog): the page leaves
  // the keys to it.
  shellLayer(): 'dialog' | null;
  // The finding an exploration PR's Fichas tab shows (#93), and whether it's
  // open (on a phone, over the list): the shell keeps it, since the address
  // carries it (?f=). Null before one was picked.
  ficha(key: string): { ficha: string | null; open: boolean };
  showFicha(key: string, ficha: string | null, open: boolean): void;
}


export type SnapshotItem = Snapshot['items'][number];
export type { ItemDetail, ItemRun, ShownRun };

export interface ItemView {
  item: SnapshotItem;
  // Read from GitHub when the item is opened, and again once old; null
  // before it was asked for.
  detail: { data: ItemDetail | null; error: string | null } | null;
  // Its runs of the last 14 days, newest first; null before they're read.
  runs: ItemRun[] | null;
  // The run shown (runs[runIdx]) once read, with its lines as they come.
  run: ShownRun | null;
  runIdx: number;
  view: 'ficha' | 'tx';
  // The page's tabs ([key, label]) and the one shown, once the detail is
  // read.
  tabs: Array<[string, string]>;
  doc: string | null;
  // A PR of ronin's that's decided here (Aprobar, Ajustar, Cerrar), or
  // anyone's PR that's reviewed here.
  decidable: boolean;
  reviewable: boolean;
  // An exploration PR's app (#155), whose page it is.
  exploration: ExplorationRow | null;
}

export interface ExplorationsView {
  rows: ExplorationRow[];
  // What /api/explorations adds to each row, once read, or why it couldn't be.
  list: ExplorationListRow[] | null;
  error: string | null;
  // The apps launched from here, by repo, until the snapshot sees them.
  launched: Record<string, { app: string; at: number }>;
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
