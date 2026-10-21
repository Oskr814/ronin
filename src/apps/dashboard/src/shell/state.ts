import { QueryClient } from '@tanstack/react-query';
import type { ItemDetail, ItemRun, ShownRun, Snapshot } from '../api.js';
import type { ExplorationListRow, ExplorationRow, ExplorationsView, ItemView, SnapshotItem } from '../host.js';
import { isMobile } from '../lib/format.js';
import { md as markdown } from '../lib/md.js';

// The dashboard's shell (#65): what it has open and what it read, the
// routes, and what reads the API for the sidebar, the context column and an
// item's page. Plain state with a version: the shell's components redraw
// each time it changes (useShell), and so do the pages that read it through
// Host (subscribe).

export const SNAPSHOT_EVERY_MS = 5000;
// A portal request's page (#132), read again this often while it's open.
const PEDIDO_EVERY_MS = 10_000;
const DETAIL_EVERY_MS = 30_000;
const XPL_EVERY_MS = 60_000;
const MIN = 60e3;

export type Item = SnapshotItem;
type Detail = { data?: ItemDetail; error?: string | null; loading?: boolean; at?: number };
export type Page = null | 'pedidos' | 'pedido' | 'reuniones' | 'reunion' | 'despliegues' | 'metricas' | 'exploraciones' | 'exploracion' | 'ajustes';
export interface NewIssue {
  repo: string;
  title: string;
  body: string;
  after: string;
  app: string;
  instruction: string;
  projectId: string;
  cycleId: string;
  tab: 'write' | 'preview';
  sending: boolean;
  error: string | null;
}

// One cache for every page: going back to one shows what it had. The
// snapshot is in it too (SNAPSHOT_KEY).
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
export const SNAPSHOT_KEY = ['snapshot'];

export const S = {
  snap: null as Snapshot | null,
  booted: false,
  // The login, with why the session ended; the notice to log in again in
  // another tab while something written is on screen.
  login: null as { why: string | null } | null,
  relogin: null as string | null,
  sel: null as string | null,
  open: [] as string[],
  runIdx: {} as Record<string, number>,
  pendingRun: null as string | null,
  filter: null as 'running' | 'queue' | null,
  q: '',
  itemRuns: {} as Record<string, ItemRun[]>,
  run: null as ShownRun | null,
  stream: null as EventSource | null,
  detail: {} as Record<string, Detail>,
  view: {} as Record<string, 'ficha' | 'tx'>,
  doc: {} as Record<string, string>,
  ficha: {} as Record<string, string>,
  fichaOpen: {} as Record<string, boolean>,
  scope: 'all' as 'all' | 'cycle',
  project: '',
  // What was opened by its number without being in the list (#100): a
  // closed issue, a PR without an issue.
  extra: {} as Record<string, Item>,
  newIssue: null as NewIssue | null,
  keysHelp: false,
  toast: null as { message: string; url?: string; id: number } | null,
  revSent: {} as Record<string, { repo: string; pr: number; decision: string; readAt: string | null; at: number }>,
  page: null as Page,
  // A phone shows the sidebar (list) or the page (detail).
  m: 'list' as 'list' | 'detail',
  ped: { n: null as number | null, run: null as string | null },
  reu: { n: null as number | null, run: null as string | null },
  xpl: { list: null as ExplorationListRow[] | null, error: null as string | null, listAt: 0, repo: null as string | null, app: null as string | null, launched: {} as Record<string, { app: string; at: number }> },
  xnow: null as { repo: string; app: string } | null,
  mt: { tab: 'trabajo' as 'trabajo' | 'suscripcion' },
  aj: { sec: 'perfil', login: null as string | null, repo: null as string | null, cuenta: null as string | null, f: null as string | null, visits: 0 },
};
// The sidebar's Linear filter (#101), remembered per browser.
try { Object.assign(S, JSON.parse(localStorage.getItem('ronin-scope') ?? '{}')); } catch { /* sin storage */ }
export function saveScope() {
  try { localStorage.setItem('ronin-scope', JSON.stringify({ scope: S.scope, project: S.project })); } catch { /* sin storage */ }
}

// ---------- who's told
const listeners = new Set<() => void>();
let version = 0;
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getVersion = () => version;
// The item views of a version (Host.item): the same object until it changes.
const itemViews = new Map<string, ItemView | null>();
export function changed() {
  version += 1;
  itemViews.clear();
  for (const listener of listeners) listener();
}

// ---------- the API
export class Unauthorized extends Error {}

// Why the session ended, in the server's words when it says more than that
// there's none (a GitHub token revoked).
async function sessionEnded(response: Response) {
  const why = ((await response.json().catch(() => null)) as { error?: string } | null)?.error;
  return why && why !== 'sin sesión' ? why : 'Tu sesión del tablero venció. Volvé a entrar.';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (response.status === 401) throw new Unauthorized(await sessionEnded(response));
  if (S.relogin) {
    S.relogin = null;
    changed();
  }
  if (!response.ok) {
    // The API's own explanation when it has one (an action it refused).
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    // The rest of it too, for whoever needs more than the words (a deploy's new plan, #158).
    throw Object.assign(new Error(body?.error ?? `${path}: ${response.status}`), { body });
  }
  return (response.status === 204 ? null : response.json()) as Promise<T>;
}

// The session ended. With something written on screen (a dialog open, a
// comment half done) the page stays: a notice on top logs in again in
// another tab, and what was written is still here to send again. Returns
// whether the page went to the login (otherwise the caller shows its error).
export function showLogin(error?: Error): boolean {
  const writing = document.querySelector('body > div > .scrim, body > .scrim') || [...document.querySelectorAll<HTMLTextAreaElement>('#shell textarea')].some((area) => area.value.trim());
  if (error && writing) {
    S.relogin = error.message;
    changed();
    return false;
  }
  S.login = { why: error && S.snap ? error.message : null };
  changed();
  return true;
}

// ---------- items
const TYPE: Record<string, string> = {
  'plan': 'Planificar', 'implement-slice': 'Implementar slice', 'fix-issue': 'Resolver issue', 'fix-review': 'Responder review',
  'fix-e2e': 'Arreglar e2e', 'review-request': 'Pedido en review', 'fix-comments': 'Aplicar comentarios',
  'fix-comments-external': 'Aplicar comentarios', 'resolve-conflicts': 'Resolver conflictos', 'thread-reply-external': 'Responder hilo',
  'external-review': 'Review externa', 'spike': 'Spike', 'write-spec': 'Escribir spec', 'revise-spec': 'Conversar el spec', 'issue-request': 'Pedido en issue',
  'prototype': 'Prototipo', 'update-changelog': 'Changelog', 'explore-inventory': 'Inventario de exploración',
  'explore-function': 'Explorar', 'explore-evaluate': 'Evaluar exploración', 'explore-redo-after': 'Rehacer captura',
  'explore-feedback': 'Comentarios de exploración', 'commit-subject': 'Mensaje de commit', 'prepare-preview-data': 'Datos de preview', 'preview-seed-catalog': 'Catálogo de seeds', 'preview-data-triage': 'Revisión de los seeds', 'preview-data-delta': 'Datos de preview al actualizarse', 'portal-request': 'Pedido del portal', 'portal-interview': 'Respuestas de la entrevista', 'portal-prototype': 'Prototipo del portal', 'portal-reproduce': 'Reproducción del portal', 'meeting-read': 'Lectura de reunión',
};
export const typeName = (type: string) => TYPE[type] ?? type;
// Runs that are steps of one thing (platform/agents/run-group.ts): a preview's seed
// catalog, "¿alcanzan los seeds?" and its data are one preview.
const GROUP_NAME: Record<string, string> = { preview: 'Preview' };
const groupName = (run: { group?: string } | null | undefined) => (run?.group ? GROUP_NAME[run.group.split(':')[0]] : undefined);
// What a run is: its group's name, or its own task's.
export const runKind = (run: { group?: string; taskType: string }) => groupName(run) ?? typeName(run.taskType);
// A step of a group says which one: "Preview: Revisión de los seeds".
export const runTitle = (run: { group?: string; taskType: string }) => (groupName(run) ? `${groupName(run)}: ${typeName(run.taskType)}` : typeName(run.taskType));

// What the session can do in a repo (#174): the server says it per repo; an
// admin does everything. The server refuses anyway, this only hides it.
export function canDo(repo: string, perm: string): boolean {
  if (S.snap?.access.admin) return true;
  const entry = S.snap?.access.repos.find((r) => r.repo === repo) as { perms?: Record<string, boolean> } | undefined;
  if (!entry) return false;
  return entry.perms ? entry.perms[perm] : perm !== 'desplegar';
}

const repoIndex = (repo: string) => Math.max(0, (S.snap?.repos ?? []).indexOf(repo));
export const repoColor = (repo: string) => `var(--repo-${repoIndex(repo) % 4})`;
export const repoShort = (repo: string) => repo.split('/')[1] ?? repo;
export const itemById = (id: string | null): Item | undefined => (id ? S.snap?.items.find((item) => item.id === id) ?? S.extra[id] : undefined);
export const safeRepo = (repo: string) => /^[\w.-]+\/[\w.-]+$/.test(repo);
export const md = (text: string, repo: string) => markdown(text, repo, S.snap?.repos ?? []);

// ---------- Linear (#101)
export const linearRepos = () => S.snap?.linear ?? [];
export const currentCycleOf = (repo: string) => linearRepos().find((l) => l.repo === repo)?.cycle ?? null;
// A project's color follows the project, never its rank: the projects known
// to the page in name order, the first four with a color each, the rest gray.
export function projectColor(id: string): string {
  const names = new Map<string, string>();
  for (const item of S.snap?.items ?? []) if (item.linear?.project) names.set(item.linear.project.id, item.linear.project.name);
  const today = queryClient.getQueryData<{ cycles: Array<{ issues: Array<{ project?: { id: string; name: string } | null }> }> }>(['today']);
  for (const c of today?.cycles ?? []) for (const i of c.issues) if (i.project) names.set(i.project.id, i.project.name);
  const order = [...names].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([pid]) => pid);
  const k = order.indexOf(id);
  return k >= 0 && k < 4 ? `var(--proj-${k})` : 'var(--proj-other)';
}
export const inScope = (item: Item) => (S.scope !== 'cycle' || item.linear?.cycle?.current) && (!S.project || item.linear?.project?.id === S.project);

// ---------- an item's page (#85)
// The item's runs: the ones read, or its last one until they are.
export const itemRuns = (item: Item): ItemRun[] => S.itemRuns[item.id] ?? (item.lastRun ? [item.lastRun as ItemRun] : []);
// The item's page by default; the transcript for what has no page (a changelog entry).
export const viewOf = (item: Item) => S.view[item.id] ?? (item.kind === 'other' ? 'tx' : 'ficha');

function docTabsOf(item: Item, d: ItemDetail | undefined): Array<[string, string]> {
  // Archivos: the PR's "Files changed" (#111), an issue's moving PR's.
  // An issue with a PR opens on the PR, what was done (its "Qué se pidió" says what was asked).
  if (item.kind === 'issue') return d?.pr ? [['pr', `PR #${d.pr.number}`], ['issue', 'Issue'], ['files', 'Archivos']] : [['issue', 'Issue']];
  // An exploration PR opens on its findings, to review them (#93); as its app's page, with the app's runs and inventory (#155).
  const xpl: Array<[string, string]> = d?.exploration && xplOfItem(item.id) ? [['corridas', 'Corridas'], ['inventario', 'Inventario']] : [];
  return [...(d?.exploration ? [['fichas', 'Fichas'] as [string, string]] : []), ...xpl, ['pr', 'Descripción'], ...(d?.issue ? [['issue', `Issue #${d.issue.number}`] as [string, string]] : []), ['files', 'Archivos']];
}
export const docOf = (item: Item): string | null => {
  const d = S.detail[item.id]?.data;
  if (!d) return null;
  const tabs = docTabsOf(item, d);
  return tabs.some(([k]) => k === S.doc[item.id]) ? S.doc[item.id] : tabs[0][0];
};
export const sameLogin = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
// A PR's page offers the review, and so does an issue's, for its moving PR
// (the one in its Archivos tab); an exploration PR has its own approval (#93).
const reviewable = (item: Item, d: ItemDetail) => (item.kind === 'pr' || item.kind === 'issue') && !d?.exploration && d?.pr?.state === 'OPEN';
// A PR ronin opened, decided in the item's page (pages/item/Decide.tsx, #195).
const decidable = (item: Item, d: ItemDetail) => reviewable(item, d) && Boolean(d.ronin) && (d.pr!.author ?? '').toLowerCase() === d.ronin!.toLowerCase() && !d.pr!.isDraft;

// The item as its page sees it (Host.item): what the shell read of it.
export function itemView(key: string): ItemView | null {
  if (itemViews.has(key)) return itemViews.get(key)!;
  const item = itemById(key);
  let view: ItemView | null = null;
  if (item) {
    const entry = S.detail[key];
    const d = entry?.data;
    view = {
      item,
      detail: entry ? { data: d ?? null, error: entry.error ?? null } : null,
      runs: S.itemRuns[key] ?? null,
      run: S.run,
      runIdx: S.runIdx[key] ?? 0,
      view: viewOf(item),
      tabs: d ? docTabsOf(item, d) : [],
      doc: docOf(item),
      decidable: Boolean(d) && decidable(item, d!),
      reviewable: Boolean(d) && reviewable(item, d!),
      exploration: xplOfItem(key),
    };
  }
  itemViews.set(key, view);
  return view;
}

// The items a request's page shows (Host.watchItem), read again once old.
const watched = new Set<string>();
export function watchItem(key: string, kind: 'issue' | 'pr') {
  // Not in the sidebar (a team issue nobody took): known by its number, as select() does.
  const n = Number(key.split('#')[1]);
  if (!itemById(key)) S.extra[key] = { id: key, repo: key.split('#')[0], number: n, kind, title: `#${n}`, status: 'open', runs: 0, listed: false } as unknown as Item;
  watched.add(key);
  changed();
  const entry = S.detail[key];
  if (!entry?.data && !entry?.loading && !entry?.error) void loadDetail(key);
  return () => {
    watched.delete(key);
  };
}

// ---------- deciding, reviewing (#195, #111)
// A PR of ronin's that's ready for someone to decide: open, not a draft,
// nobody approved it yet and no agent is on it.
function awaitsDecision(item: Item) {
  const pr = item.pr;
  return Boolean(pr && S.snap?.ronin) && sameLogin(pr!.author, S.snap!.ronin) && !pr!.isDraft && pr!.reviewDecision !== 'APPROVED' && item.status !== 'running';
}

// In the sidebar's order: repo by repo, as listed. From where the page is,
// so one just decided (no longer waiting) still moves on.
export function movePr(step: 1 | -1) {
  const listed = (S.snap?.repos ?? []).flatMap((repo) => (S.snap?.items ?? []).filter((i) => i.repo === repo && i.listed && i.status !== 'blocked'));
  // A ronin PR is listed as its issue: its own page is the issue's too.
  const here = (i: Item) => i.id === S.sel || Boolean(i.pr && `${i.repo}#${i.pr.number}` === S.sel);
  const at = listed.findIndex(here);
  for (let k = 1; k <= listed.length; k++) {
    const i = listed[((at < 0 ? (step > 0 ? -1 : 0) : at) + step * k + listed.length * k) % listed.length];
    if (awaitsDecision(i) && !here(i)) return void select(i.id);
  }
  toast('Ningún otro PR de ronin espera una decisión.');
}

// An approval or a request for changes shows on the PR's chips at once,
// until a snapshot brings a read of the repo newer than the one at hand when
// it was sent (the server reads it again right after); a couple of minutes
// at most, if that read never comes.
const REVIEW_SHOWN_MS = 120_000;
const repoReadAt = (repo: string) => S.snap?.github?.find((g) => g.repo === repo)?.fetchedAt ?? null;

function showSentReviews() {
  for (const [key, sent] of Object.entries(S.revSent)) {
    if (repoReadAt(sent.repo) !== sent.readAt || Date.now() - sent.at > REVIEW_SHOWN_MS) {
      delete S.revSent[key];
      continue;
    }
    for (const item of [...(S.snap?.items ?? []), ...Object.values(S.extra)]) {
      if (item.repo === sent.repo && item.pr?.number === sent.pr) (item.pr as { reviewDecision?: string }).reviewDecision = sent.decision;
    }
  }
}

export function reviewed(key: string, pr: number, decision: string) {
  const item = itemById(key);
  if (!item) return;
  S.revSent[`${item.repo}#${pr}`] = { repo: item.repo, pr, decision, readAt: repoReadAt(item.repo), at: Date.now() };
  showSentReviews();
  changed();
}

// ---------- overlays
let toastTimer = 0;
export function toast(message: string, url?: string) {
  // The newest says it all: one on top of another can't be read.
  clearTimeout(toastTimer);
  S.toast = { message, url, id: (S.toast?.id ?? 0) + 1 };
  changed();
  toastTimer = window.setTimeout(() => {
    S.toast = null;
    changed();
  }, 5000);
}

export function toggleKeysHelp() {
  S.keysHelp = !S.keysHelp;
  changed();
}

export function openNewIssue(repo: string) {
  const apps = (S.snap?.apps as Record<string, string[]> | undefined)?.[repo] ?? [];
  S.newIssue = { repo, title: '', body: '', after: 'none', app: apps[0] ?? '', instruction: '', projectId: '', cycleId: '', tab: 'write', sending: false, error: null };
  changed();
}

export function closeNewIssue() {
  if (S.newIssue?.sending) return;
  S.newIssue = null;
  changed();
}

export async function sendNewIssue() {
  const n = S.newIssue;
  if (!n || n.sending || !n.title.trim()) return;
  n.sending = true;
  n.error = null;
  changed();
  try {
    const command = n.after === 'spike' || n.after === 'spec';
    const created = await api<{ id: string; number: number; url: string }>(`/api/repos/${n.repo}/issues`, { method: 'POST', body: JSON.stringify({ title: n.title, body: n.body, after: n.after, ...(command ? { app: n.app, instruction: n.instruction } : {}), ...(n.projectId ? { projectId: n.projectId } : {}), ...(n.cycleId ? { cycleId: n.cycleId } : {}) }) });
    S.newIssue = null;
    changed();
    toast(`Listo: creaste #${created.number}${n.after === 'assign' ? ' y se lo asignaste a ronin' : command ? ` y pediste /${n.after}` : ''}.${n.projectId || n.cycleId ? ' El proyecto y el ciclo se le ponen en Linear apenas la sincronización lo cree allá.' : ''}`, created.url);
    await refresh();
    void select(created.id);
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
    n.sending = false;
    n.error = `No se pudo: ${(error as Error).message}`;
    changed();
  }
}

// Explorar ahora (pages/explorations/ExploreNow.tsx), open on its own: the
// app's page and its exploration PR's head open it.
export function openExploreNow(repo: string, app: string) {
  if (S.xnow) return;
  S.xnow = { repo, app };
  changed();
}

export function closeExploreNow() {
  if (!S.xnow) return;
  S.xnow = null;
  changed();
}

// ---------- explorations (#155)
// One row per app a repo explores, from the snapshot; the list
// (/api/explorations) adds its exploration PR's findings counted, the last
// run and the next. An app's page is its repo's exploration PR's page (#93),
// headed as the app's; with no PR open, a page of its own until ronin opens one.
export const xplRows = (): ExplorationRow[] => (S.snap?.exploraciones ?? []) as ExplorationRow[];
const xplRow0 = (repo: string | null, app: string | null) => xplRows().find((r) => r.repo === repo && r.app === app) ?? null;
const xplListRow = (r: ExplorationRow) => S.xpl.list?.find((x) => x.repo === r.repo && x.app === r.app) ?? null;
export const xplCounts = (r: ExplorationRow) => xplListRow(r)?.fichas ?? null;
export const xplToDecide = () => xplRows().reduce((n, r) => n + (xplCounts(r)?.decidir ?? 0), 0);
const xplPath = (repo: string, app: string) => `/exploraciones/${repo}/${encodeURIComponent(app)}`;
// The app whose page an item is: its repo's exploration PR, the app open
// now when the repo explores more than one.
export function xplOfItem(id: string): ExplorationRow | null {
  const rows = xplRows().filter((r) => r.pr?.id === id);
  return rows.find((r) => r.repo === S.xpl.repo && r.app === S.xpl.app) ?? rows[0] ?? null;
}
export function itemPath(id: string) {
  const xr = xplOfItem(id);
  return xr ? xplPath(xr.repo, xr.app) : `/i/${encodeURIComponent(id)}`;
}

// The apps as the pages see them (Host.explorations), made again when the
// snapshot or the list change.
let xplView: ExplorationsView | null = null;
export const explorationsView = () => (xplView ??= { rows: xplRows(), list: S.xpl.list, error: S.xpl.error, launched: { ...S.xpl.launched } });
function xplChanged() {
  xplView = null;
  changed();
}

export async function loadExploraciones() {
  // Taken before asking, so the snapshots meanwhile don't ask again.
  S.xpl.listAt = Date.now();
  try {
    S.xpl.list = (await api<{ apps: ExplorationListRow[] }>('/api/explorations')).apps;
    S.xpl.error = null;
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
    S.xpl.error = (error as Error).message;
  }
  xplChanged();
}

export function explored(repo: string, app: string) {
  S.xpl.launched[repo] = { app, at: Date.now() };
  closeExploreNow();
  xplChanged();
  void refresh().then(loadExploraciones);
}

// ---------- going places
// The page opens on a phone, at the top.
function shown() {
  if (isMobile()) {
    S.m = 'detail';
    scrollTo(0, 0);
  }
}
function go(path: string) {
  if (location.pathname !== path) history.pushState(null, '', path);
}
// Leaves the item open, for one of the pages.
function toPage(page: Page) {
  S.sel = null;
  S.page = page;
  stopStream();
}

export function goHome() {
  toPage(null);
  go('/');
  changed();
  shown();
  void refresh();
}

export function back() {
  S.m = 'list';
  changed();
  scrollTo(0, 0);
}

export function openExploraciones() {
  toPage('exploraciones');
  go('/exploraciones');
  changed();
  shown();
  void loadExploraciones();
}

// `ficha`: the finding to open, from the URL (?f=).
export function openExploracion(repo: string, app: string, ficha?: string | null) {
  Object.assign(S.xpl, { repo, app });
  const r = xplRow0(repo, app);
  if (r?.pr) {
    if (ficha) {
      S.ficha[r.pr.id] = ficha;
      S.fichaOpen[r.pr.id] = true;
    }
    void select(r.pr.id);
    return;
  }
  toPage('exploracion');
  go(xplPath(repo, app));
  changed();
  shown();
  void loadExploraciones();
}

export function openPedidos() {
  toPage('pedidos');
  go('/pedidos');
  changed();
  shown();
}

// `run`: one of its runs to show on its Corridas tab (Hoy's timeline).
export function openPedido(n: number, run: string | null = null) {
  toPage('pedido');
  S.ped = { n, run };
  go(`/pedidos/${n}`);
  changed();
  shown();
}

// Despliegues (#158): admins only.
export function openDespliegues() {
  toPage('despliegues');
  go('/despliegues');
  changed();
  shown();
}

// `tab`: trabajo (#222) or suscripcion (#234), each at its own address. Admins only.
export function openMetricas(tab: string = S.mt.tab) {
  toPage('metricas');
  S.mt.tab = tab === 'suscripcion' ? 'suscripcion' : 'trabajo';
  go(S.mt.tab === 'suscripcion' ? '/metricas/suscripcion' : '/metricas');
  changed();
  shown();
}

export function openReuniones() {
  toPage('reuniones');
  go('/reuniones');
  changed();
  shown();
}

// `run`: one of its runs, to open the page on (a run picked elsewhere).
export function openReunion(n: number, run: string | null = null) {
  toPage('reunion');
  S.reu = { n, run };
  go(`/reuniones/${n}`);
  changed();
  shown();
}

// Ajustes (#174): its own sidebar (Tu cuenta, and Administración for
// admins) and one page per section.
export const AJ_SECTIONS: Record<string, { name: string; icon: string; admin?: boolean }> = {
  perfil: { name: 'Perfil', icon: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>' },
  notificaciones: { name: 'Notificaciones', icon: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>' },
  general: { name: 'General', icon: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>', admin: true },
  repos: { name: 'Repos', icon: '<path d="M5 4h11l3 3v13H5zM9 9h6M9 13h6"/>', admin: true },
  agentes: { name: 'Agentes', icon: '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01"/>', admin: true },
  cuentas: { name: 'Cuentas de Claude', icon: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>', admin: true },
  exploracion: { name: 'Exploración', icon: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M14 8l-2 4-4 2 2-4z"/>', admin: true },
  previews: { name: 'Previews', icon: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', admin: true },
  conexiones: { name: 'Conexiones', icon: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>', admin: true },
  usuarios: { name: 'Usuarios', icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .7 3.2 2.6 3.7 5.5"/>', admin: true },
  registro: { name: 'Registro', icon: '<path d="M4 6h16M4 12h16M4 18h10"/>', admin: true },
};
const ajAllowed = (sec: string) => AJ_SECTIONS[sec] && (!AJ_SECTIONS[sec].admin || S.snap?.access.admin);

// `login`: one of the team (for Repos, the repo: owner/name); `cuenta`: one
// of the portal's accounts (#174, stage 3); `f`: the list's filter (todos,
// equipo, portal). The page is mounted again on each visit: it reads what to
// show, and reads it again.
export function openAjustes(sec = 'perfil', login: string | null = null, f: string | null = null, cuenta: string | null = null) {
  S.aj.visits += 1;
  toPage('ajustes');
  S.aj.sec = ajAllowed(sec) ? sec : 'perfil';
  S.aj.login = S.aj.sec === 'usuarios' && !cuenta ? login : null;
  S.aj.repo = S.aj.sec === 'repos' ? login : null;
  S.aj.cuenta = S.aj.sec === 'usuarios' ? cuenta : null;
  // Asked for once (Pedidos del portal → Usuarios); the page keeps the last one chosen.
  S.aj.f = f;
  go(`/ajustes/${S.aj.sec}${S.aj.cuenta ? `/cuenta/${encodeURIComponent(S.aj.cuenta)}` : S.aj.login ? `/${encodeURIComponent(S.aj.login)}` : S.aj.repo ? `/${S.aj.repo}` : ''}`);
  changed();
  if (sec) shown();
}

export function closeTab(id: string) {
  S.open = S.open.filter((x) => x !== id);
  if (S.sel === id) {
    if (S.open[0]) void select(S.open[0]);
    else {
      S.sel = null;
      S.page = null;
      stopStream();
      history.pushState(null, '', '/');
      changed();
    }
  } else changed();
}

export async function select(id: string) {
  // A meeting's run opens the meeting's page, on that run (#62).
  const reu = /:meeting-read:reunión R-(\d+)/.exec(id);
  if (reu) {
    const runId = S.pendingRun;
    S.pendingRun = null;
    openReunion(Number(reu[1]), runId);
    return;
  }
  // A portal request's run (Hoy's timeline) opens the request's page, on that run (#132).
  const ped = /:portal-(?:request|prototype):pedido P-(\d+)/.exec(id);
  if (ped) {
    const runId = S.pendingRun;
    S.pendingRun = null;
    openPedido(Number(ped[1]), runId);
    return;
  }
  const n = /^(.+)#(\d+)$/.exec(id);
  if (!itemById(id) && n) S.extra[id] = { id, repo: n[1], number: Number(n[2]), kind: 'issue', title: `#${n[2]}`, status: 'open', runs: 0, listed: false } as unknown as Item;
  // An exploration PR is its app's page (#155).
  const xr = xplOfItem(id);
  if (xr) Object.assign(S.xpl, { repo: xr.repo, app: xr.app });
  S.sel = id;
  S.page = xr ? 'exploracion' : null;
  S.runIdx[id] = 0;
  delete S.view[id];
  if (!S.open.includes(id)) S.open.push(id);
  const path = itemPath(id);
  if (location.pathname !== path) history.pushState(null, '', S.ficha[id] ? `${path}?f=${encodeURIComponent(S.ficha[id])}` : path);
  changed();
  shown();
  void loadDetail(id);
  await loadItem(id);
}

// ---------- reading
export function stopStream() {
  if (S.stream) S.stream.close();
  S.stream = null;
}

export async function loadShownRun() {
  const item = itemById(S.sel);
  if (!item) return;
  const runs = S.itemRuns[item.id] ?? (item.lastRun ? [item.lastRun as ItemRun] : []);
  stopStream();
  if (runs.length === 0) {
    S.run = null;
    changed();
    return;
  }
  const shown = runs[Math.min(S.runIdx[item.id] ?? 0, runs.length - 1)];
  S.run = null;
  changed();
  try {
    const { summary, lines } = await api<{ summary: ShownRun['summary']; lines: ShownRun['lines'] }>(`/api/runs/${encodeURIComponent(shown.runId)}`);
    const steps = lines.filter((line) => line.type !== 'run_start' && line.type !== 'run_end');
    S.run = { runId: shown.runId, summary, lines: steps };
    changed();
    if (summary.state === 'running') follow(shown.runId, lines.length);
  } catch (error) {
    if (error instanceof Unauthorized) showLogin(error);
  }
}

// The run still going: its new lines as they're written.
function follow(runId: string, from: number) {
  const stream = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream?from=${from}`);
  S.stream = stream;
  stream.onmessage = (event) => {
    if (!S.run || S.run.runId !== runId) return;
    const line = JSON.parse(event.data as string) as ShownRun['lines'][number];
    if (line.type === 'run_end') return;
    S.run = { ...S.run, lines: [...S.run.lines, line] };
    changed();
  };
  stream.addEventListener('end', () => {
    stopStream();
    void refresh().then(() => loadItem(S.sel));
  });
  stream.onerror = () => stopStream();
}

async function loadItem(id: string | null) {
  if (!id) return;
  try {
    const { runs } = await api<{ runs: ItemRun[] }>(`/api/items/${encodeURIComponent(id)}`);
    S.itemRuns[id] = runs;
    if (S.pendingRun) {
      const index = runs.findIndex((run) => run.runId === S.pendingRun);
      // A run picked on Hoy's timeline opens as its transcript.
      if (index >= 0) {
        S.runIdx[id] = index;
        S.view[id] = 'tx';
      }
      S.pendingRun = null;
    }
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
  }
  if (S.sel === id) await loadShownRun();
}

// The item's issue and PR from GitHub. The server caches them, so asking
// again only costs a call to GitHub once its copy is old.
export async function loadDetail(id: string) {
  const item = itemById(id);
  const entry = (S.detail[id] ??= {});
  if (!item || item.kind === 'other' || entry.loading) return;
  entry.loading = true;
  try {
    entry.data = await api<ItemDetail>(`/api/items/${encodeURIComponent(id)}/detail`);
    entry.error = null;
    const extra = S.extra[id] as (Item & { url?: string }) | undefined;
    const ref = (entry.data as { ref?: { kind: 'issue' | 'pr' } }).ref;
    const doc = extra && (ref?.kind === 'pr' ? entry.data.pr : entry.data.issue);
    if (extra && doc) Object.assign(extra, { kind: ref!.kind, title: doc.title, url: doc.url, status: doc.state === 'OPEN' ? 'open' : 'ok' });
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
    entry.error = (error as Error).message;
  } finally {
    entry.loading = false;
    entry.at = Date.now();
  }
  changed();
}

export function showRun(key: string, index: number, view: 'ficha' | 'tx') {
  S.view[key] = view;
  S.runIdx[key] = index;
  void loadShownRun();
}

export function showDoc(key: string, tab: string) {
  S.doc[key] = tab;
  changed();
}

export function reread(key: string) {
  if (S.detail[key]) S.detail[key].at = 0;
  void loadDetail(key);
  void refresh();
}

// The snapshot: the sidebar, the status bar, the items. Read every
// SNAPSHOT_EVERY_MS (the shell's query) and after what changes it.
export async function readSnapshot(): Promise<Snapshot> {
  let snap: Snapshot;
  try {
    snap = await api<Snapshot>('/api/snapshot');
  } catch (error) {
    if (error instanceof Unauthorized) showLogin(error);
    throw error;
  }
  S.snap = snap;
  showSentReviews();
  xplChanged();
  await followNewRun();
  changed();
  const detail = S.sel && S.detail[S.sel];
  if (detail && Date.now() - (detail.at ?? 0) > DETAIL_EVERY_MS) void loadDetail(S.sel!);
  for (const key of watched) if (Date.now() - (S.detail[key]?.at ?? 0) > DETAIL_EVERY_MS) void loadDetail(key);
  // The apps' findings, more often while their page is open: the sidebar counts them too.
  if (xplRows().length && Date.now() - S.xpl.listAt > (S.page === 'exploraciones' || S.page === 'exploracion' ? PEDIDO_EVERY_MS : XPL_EVERY_MS)) void loadExploraciones();
  // An app's page with no PR goes on to it once ronin opens one.
  const xr = S.page === 'exploracion' && !S.sel && xplRow0(S.xpl.repo, S.xpl.app);
  if (xr && xr.pr) void select(xr.pr.id);
  return snap;
}

export async function refresh() {
  try {
    await queryClient.fetchQuery({ queryKey: SNAPSHOT_KEY, queryFn: readSnapshot, staleTime: 0 });
  } catch {
    // Said already (the login), or the next one will tell.
  }
}

// A new run on the open item: its list of runs is read again. Whoever was
// looking at the latest one moves on to the new one (and follows it live);
// whoever was looking at an older one stays on it.
async function followNewRun() {
  const item = itemById(S.sel);
  const known = S.sel ? S.itemRuns[S.sel] : undefined;
  if (!item?.lastRun || !known || known.some((run) => run.runId === item.lastRun!.runId)) return;
  const id = S.sel!;
  const index = S.runIdx[id] ?? 0;
  const viewing = known[index]?.runId;
  let runs: ItemRun[];
  try {
    ({ runs } = await api<{ runs: ItemRun[] }>(`/api/items/${encodeURIComponent(id)}`));
  } catch (error) {
    if (error instanceof Unauthorized) showLogin(error);
    return;
  }
  if (S.sel !== id) return;
  S.itemRuns[id] = runs;
  if (index === 0) {
    S.runIdx[id] = 0;
    await loadShownRun();
  } else {
    S.runIdx[id] = Math.max(0, runs.findIndex((run) => run.runId === viewing));
  }
}

// ---------- routes
// /pedidos, /pedidos/<n> (#132), /portal (the accounts, admins only),
// /reuniones and /reuniones/<n> (#62), /exploraciones and
// /exploraciones/<owner>/<repo>/<app> (#155), /despliegues (#158, admins
// only), /metricas[/suscripcion] (#222, admins only), /ajustes/… (#174):
// false for any other path.
export function openPortalPath(): boolean {
  const n = /^\/pedidos\/(\d+)$/.exec(location.pathname)?.[1];
  const r = /^\/reuniones\/(\d+)$/.exec(location.pathname)?.[1];
  const x = /^\/exploraciones\/([\w.-]+\/[\w.-]+)\/([^/]+)$/.exec(location.pathname);
  const aj = /^\/ajustes(?:\/(\w+))?(?:\/([\w-]+))?(?:\/([\w-]+))?$/.exec(location.pathname);
  if (aj && aj[1] === 'usuarios' && aj[2] === 'cuenta' && aj[3]) openAjustes('usuarios', null, null, aj[3]);
  else if (aj && aj[1] === 'repos' && aj[3]) openAjustes('repos', `${aj[2]}/${aj[3]}`);
  else if (aj) openAjustes(aj[1] ?? 'perfil', aj[2] ?? null);
  else if (x) openExploracion(x[1], decodeURIComponent(x[2]), new URLSearchParams(location.search).get('f'));
  else if (location.pathname === '/exploraciones') openExploraciones();
  else if (location.pathname === '/despliegues' && S.snap!.despliegues) openDespliegues();
  else if (/^\/metricas(\/suscripcion)?$/.test(location.pathname) && S.snap!.access?.admin) openMetricas(location.pathname === '/metricas' ? 'trabajo' : 'suscripcion');
  else if (r) openReunion(Number(r));
  else if (location.pathname === '/reuniones') openReuniones();
  else if (n) openPedido(Number(n));
  else if (location.pathname === '/pedidos') openPedidos();
  else if (location.pathname === '/portal' && S.snap!.portalAdmin) openAjustes('usuarios', null, 'portal');
  else return false;
  return true;
}

export function selectedFromPath() {
  const match = /^\/i\/(.+)$/.exec(location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

// Back and forward.
export function followPath() {
  const id = selectedFromPath();
  if (id) void select(id);
  else if (openPortalPath()) return;
  else {
    S.page = null;
    S.sel = null;
    stopStream();
    changed();
  }
}

let booting = false;
export async function boot() {
  if (booting) return;
  booting = true;
  try {
    await api('/api/auth/me');
  } catch {
    showLogin();
    return;
  }
  await refresh();
  if (!S.snap) return;
  S.booted = true;
  S.login = null;
  // Open from the start: whatever is running right now.
  S.open = S.snap.items.filter((item) => item.status === 'running').map((item) => item.id);
  const fromPath = selectedFromPath();
  const ficha = new URLSearchParams(location.search).get('f');
  if (fromPath && ficha) {
    S.ficha[fromPath] = ficha;
    S.fichaOpen[fromPath] = true;
  }
  if (fromPath) await select(fromPath);
  else if (!openPortalPath()) changed();
}

export async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

export const MINUTE = MIN;
