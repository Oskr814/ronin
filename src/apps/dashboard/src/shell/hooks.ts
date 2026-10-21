import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ExplorationListRow, ExplorationRow } from '@domains/explorations/board.js';
import type { LinearPlanning } from '@platform/linear/linear-api.js';
import type { ItemDetail, ItemRun, ShownRun, Snapshot } from '../api.js';
import { decidable, docOf, docTabsOf, reviewable } from '../lib/item.js';
import { md } from '../lib/md.js';
import {
  canDo, changed, detailQuery, DETAIL_EVERY_MS, EXPLORATIONS_KEY, follow, getVersion, itemOf, projectColor, repoColor, knowItem, readExplorations, runQuery, runsQuery, S,
  saveScope, SNAPSHOT_KEY, readSnapshot, subscribe, viewOf, xplOfItem, xplRows,
} from './state.js';

// What the pages (pages/) read of the shell around them, and what they ask of
// it. They read with hooks: the snapshot and what was read of an item from
// TanStack Query's cache, what the shell has open from its state
// (state.ts). They ask it to go places and to say things through
// `useShell()`; what changes what they show (a tab, a run, the sidebar's
// project) are the shell's own functions, exported here.

export type { ExplorationListRow, ExplorationRow, LinearPlanning };
export type SnapshotItem = Snapshot['items'][number];
export type { ItemDetail, ItemRun, ShownRun };

// ---------- what the pages ask of the shell
export interface ShellActions {
  // A note at the bottom, with a link to GitHub if there's one.
  toast(message: string, url?: string): void;
  // The session ended: the page logs in again, or says so.
  unauthorized(message: string): void;
  // Opens an item (an issue or a PR) by its key, repo#number; or on one of its runs.
  openItem(key: string): void;
  openRun(key: string, runId: string): void;
  // Opens a section of Ajustes (#174): in Usuarios, one of the team (in
  // Repos, a repo: owner/name), the list's filter, or one of the portal's
  // accounts. Or the portal's accounts.
  openSettings(section: string, login?: string | null, filter?: string | null, account?: string | null): void;
  openPortalAccounts(): void;
  // A tab of Métricas.
  openMetrics(tab: 'trabajo' | 'suscripcion'): void;
  // A portal request's page, or the list of them.
  openRequest(n: number): void;
  openRequests(): void;
  // Reuniones (#62): the list, or a meeting's page.
  openMeetings(): void;
  openMeeting(n: number): void;
  // Exploraciones (#155): the list of the apps, or an app's page (its
  // exploration PR's when it has one).
  openExplorations(): void;
  openExploration(repo: string, app: string): void;
  // Opens Explorar ahora for an app, a dialog the shell opens on top: the
  // item's head opens it too.
  exploreNow(repo: string, app: string): void;
  // ]p and [p: the next or the previous PR of ronin's that waits on a
  // decision, in the sidebar's order.
  movePr(step: 1 | -1): void;
  // The keys' help (?), which the whole dashboard has.
  keysHelp(): void;
}

export const ShellContext = createContext<ShellActions | null>(null);

export function useShell(): ShellActions {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('página fuera del tablero');
  return shell;
}

// What the pages change of what the shell has open.
export { explored, refresh, reread, reviewed, showDoc, showRun } from './state.js';

// ---------- what the pages read
// The shell's state, again each time it changes.
export const useShellVersion = () => useSyncExternalStore(subscribe, getVersion);
const useShellValue = <T,>(read: () => T) => useSyncExternalStore(subscribe, read);

// The snapshot as the shell last read it (the sidebar's items, the
// previews, the repos): the shell's query reads it, the pages only look.
export function useSnapshot(): Snapshot {
  return useQuery({ queryKey: SNAPSHOT_KEY, queryFn: readSnapshot, enabled: false }).data!;
}

// Who's looking, and what the session can do in a repo (notas, aprobar,
// acciones, desplegar).
export function useSession() {
  const snap = useSnapshot();
  return {
    me: snap.me,
    portalAdmin: Boolean(snap.portalAdmin),
    repos: snap.repos,
    // The portal's requests the snapshot counts.
    requestsTotal: snap.pedidosTotal ?? 0,
    can: (repo: string, perm: string) => canDo(repo, perm, snap),
    // What a repo's Linear team offers to plan with, if it has one.
    planning: (repo: string): LinearPlanning | null => snap.linear?.find((l) => l.repo === repo)?.planning ?? null,
  };
}

// A repo's color in the sidebar.
export function useRepoColor() {
  const repos = useSnapshot().repos;
  return (repo: string) => repoColor(repo, repos);
}

// Markdown as clean HTML (lib/md.ts), its #123 linked to the repo; and
// whether the sidebar has an item, so a #123 opens it here, not on GitHub.
export function useMarkdown() {
  const snap = useSnapshot();
  return { html: (text: string, repo: string) => md(text, repo, snap.repos), hasItem: (key: string) => Boolean(itemOf(snap, key)) };
}

// The sidebar's Linear project, '' for all of them, and choosing another.
export const useProject = () => useShellValue(() => S.project);
export function setProject(id: string) {
  S.project = id;
  saveScope();
  changed();
}

// A Linear project's color, the same everywhere on the page.
export function useProjectColor() {
  const snap = useSnapshot();
  const qc = useQueryClient();
  return (id: string) => projectColor(id, snap, qc);
}

// The theme, only in this browser.
export function setTheme(theme: 'dark' | 'light') {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('ronin-theme', theme); } catch { /* sin storage */ }
  changed();
}

// What Ajustes shows, as the shell routed it (/ajustes/<sección>[/…]).
export interface SettingsView {
  section: string;
  login: string | null;
  repo: string | null;
  account: string | null;
  // Usuarios' filter, when one was asked for (todos, equipo, portal).
  filter: string | null;
}
export function useSettingsView(): SettingsView {
  useShellVersion();
  const aj = S.aj;
  return { section: aj.sec, login: aj.login, repo: aj.repo, account: aj.cuenta, filter: aj.f };
}

// What the shell has open on top of the page (a dialog), when a key comes:
// the page leaves the keys to it.
export const shellLayer = (): 'dialog' | null => (S.newIssue || S.xnow ? 'dialog' : null);

// ---------- an item (#85)
export interface ItemView {
  item: SnapshotItem;
  // Read from GitHub when the item is opened, and again once old.
  detail: { data: ItemDetail | null; error: string | null };
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

const detailOf = (q: { data?: ItemDetail; error: Error | null }) => ({ data: q.data ?? null, error: q.error?.message ?? null });

// An item's page: the item, what was read of it, and the run shown,
// followed live while it goes. Null for an item the shell doesn't know.
export function useItem(key: string): ItemView | null {
  const version = useShellVersion();
  const snap = useSnapshot();
  const item = itemOf(snap, key);
  const detail = useQuery({ ...detailQuery(key), enabled: Boolean(item) && item!.kind !== 'other', refetchInterval: DETAIL_EVERY_MS });
  const runs = useQuery({ ...runsQuery(key), enabled: Boolean(item) });
  const listed = runs.data ?? (item?.lastRun ? [item.lastRun as ItemRun] : []);
  const shown = listed.length ? listed[Math.min(S.runIdx[key] ?? 0, listed.length - 1)] : null;
  const run = useQuery({ ...runQuery(shown?.runId ?? ''), enabled: Boolean(shown) });
  const read = shown && run.data?.runId === shown.runId ? run.data : null;
  const going = read?.summary.state === 'running';
  useEffect(() => (read && going ? follow(key, read.runId, read.from) : undefined), [key, read?.runId, going, read?.from]);
  return useMemo(() => {
    if (!item) return null;
    const d = detail.data;
    const exploration = xplOfItem(key, xplRows(snap));
    const tabs = d ? docTabsOf(item, d, Boolean(exploration)) : [];
    return {
      item,
      detail: detailOf(detail),
      runs: runs.data ?? null,
      run: read && { runId: read.runId, summary: read.summary, lines: read.lines },
      runIdx: S.runIdx[key] ?? 0,
      view: viewOf(item),
      tabs,
      doc: docOf(tabs, S.doc[key]),
      decidable: Boolean(d) && decidable(item, d!),
      reviewable: Boolean(d) && reviewable(item, d!),
      exploration,
    };
  }, [version, snap, item, detail.data, detail.error, runs.data, read]);
}

// An item shown outside of its page (a request's issue or PR, #158): what
// the sidebar has of it, and its detail, read again once old. One the
// sidebar doesn't have is known by its number.
export function useWatchedItem(key: string, kind: 'issue' | 'pr') {
  useShellVersion();
  const snap = useSnapshot();
  useEffect(() => {
    if (itemOf(snap, key)) return;
    knowItem(key, kind);
    changed();
  }, [key, kind]);
  const item = itemOf(snap, key);
  const detail = useQuery({ ...detailQuery(key), enabled: Boolean(item), refetchInterval: DETAIL_EVERY_MS });
  return item ? { item, detail: detailOf(detail) } : null;
}

// An item as the sidebar has it.
export const useKnownItem = (key: string): SnapshotItem | undefined => {
  useShellVersion();
  return itemOf(useSnapshot(), key);
};

// The finding an exploration PR's Fichas tab shows (#93), and whether it's
// open (on a phone, over the list): the shell keeps it, since the address
// carries it (?f=). Null before one was picked. The tab reads it when it
// opens, and tells the shell when it changes.
export const fichaOf = (key: string) => ({ ficha: S.ficha[key] ?? null, open: Boolean(S.fichaOpen[key]) });
export { showFicha } from './state.js';

// ---------- explorations (#155)
export interface ExplorationsView {
  rows: ExplorationRow[];
  // What /api/explorations adds to each row, once read, or why it couldn't be.
  list: ExplorationListRow[] | null;
  error: string | null;
  // The apps launched from here, by repo, until the snapshot sees them.
  launched: Record<string, { app: string; at: number }>;
}

// The apps the repos explore, as the snapshot and the list the shell reads
// for the sidebar have them: the same object until either changes.
export function useExplorations(): ExplorationsView {
  const snap = useSnapshot();
  const list = useQuery({ queryKey: EXPLORATIONS_KEY, queryFn: readExplorations, enabled: false });
  const launched = useShellValue(() => S.xpl.launched);
  return useMemo(() => ({ rows: xplRows(snap), list: list.data ?? null, error: list.error?.message ?? null, launched }), [snap, list.data, list.error, launched]);
}
