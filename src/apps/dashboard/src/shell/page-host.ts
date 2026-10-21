import type { Host } from '../host.js';
import {
  canDo, changed, closeExploreNow, explorationsView, explored, itemById, itemPath, itemView, linearRepos, md, movePr, openAjustes, openExploracion,
  openExploraciones, openExploreNow, openMetricas, openPedido, openPedidos, openReunion, openReuniones, projectColor, refresh, reread, repoColor,
  reviewed, S, saveScope, select, showDoc, showLogin, showRun, subscribe, toast, toggleKeysHelp, typeName, Unauthorized, watchItem,
} from './state.js';

// What the pages ask of the shell (host.ts), from its state.
export const pageHost: Host = {
  toast,
  openPedido: (n) => openPedido(n),
  openPedidos: () => openPedidos(),
  unauthorized: (message) => void showLogin(new Unauthorized(message)),
  repoColor,
  openItem: (key) => void select(key),
  openSettings: (section, login, f, cuenta) => openAjustes(section, login ?? null, f ?? null, cuenta ?? null),
  openMetrics: (tab) => openMetricas(tab),
  settingsView: () => ({ section: S.aj.sec, login: S.aj.login, repo: S.aj.repo, account: S.aj.cuenta, filter: S.aj.f }),
  session: () => ({ me: S.snap!.me, portalAdmin: Boolean(S.snap!.portalAdmin) }),
  setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('ronin-theme', theme); } catch { /* sin storage */ }
    changed();
  },
  repos: () => S.snap!.repos,
  typeName,
  requestsTotal: () => S.snap!.pedidosTotal ?? 0,
  portalAdmin: () => Boolean(S.snap!.portalAdmin),
  openPortalAccounts: () => openAjustes('usuarios', null, 'portal'),
  watchItem,
  openMeetings: () => openReuniones(),
  openMeeting: (n) => openReunion(n),
  can: canDo,
  me: () => S.snap?.me ?? '',
  planning: (repo) => linearRepos().find((l) => l.repo === repo)?.planning ?? null,
  markdown: md,
  hasItem: (key) => Boolean(itemById(key)),
  refresh: () => void refresh(),
  snapshot: () => S.snap!,
  subscribe,
  project: () => S.project,
  setProject(id) {
    S.project = id;
    saveScope();
    changed();
  },
  projectColor,
  openRun(key, runId) {
    S.pendingRun = runId;
    void select(key);
  },
  explorations: explorationsView,
  openExplorations: () => openExploraciones(),
  openExploration: (repo, app) => openExploracion(repo, app),
  exploreNow: (repo, app) => openExploreNow(repo, app),
  explored,
  item: itemView,
  showRun,
  showDoc,
  reread,
  reviewed,
  movePr,
  keysHelp: toggleKeysHelp,
  shellLayer: () => (S.newIssue || S.xnow ? 'dialog' : null),
  // The finding an exploration PR's Fichas shows (pages/item/Fichas.tsx),
  // kept here for the address (?f=).
  ficha: (key) => ({ ficha: S.ficha[key] ?? null, open: Boolean(S.fichaOpen[key]) }),
  showFicha(key, ficha, open) {
    S.fichaOpen[key] = open;
    if (ficha === null) return;
    S.ficha[key] = ficha;
    const url = `${itemPath(key)}?f=${encodeURIComponent(ficha)}`;
    if (location.pathname + location.search !== url) history.replaceState(null, '', url);
  },
};

export { closeExploreNow };
