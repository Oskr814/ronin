import type { ShellActions } from './hooks.js';
import {
  movePr, openExploration, openExplorations, openExploreNow, openMeeting, openMeetings, openMetrics, openRequest, openRequests, openSettings, S, select,
  showLogin, toast, toggleKeysHelp, Unauthorized,
} from './state.js';

// What the pages ask of the shell (hooks.ts): to go places and to say things.
export const shellActions: ShellActions = {
  toast,
  unauthorized: (message) => void showLogin(new Unauthorized(message)),
  openItem: (key) => void select(key),
  openRun(key, runId) {
    S.pendingRun = runId;
    void select(key);
  },
  openSettings: (section, login, filter, account) => openSettings(section, login ?? null, filter ?? null, account ?? null),
  openPortalAccounts: () => openSettings('usuarios', null, 'portal'),
  openMetrics: (tab) => openMetrics(tab),
  openRequest: (n) => openRequest(n),
  openRequests: () => openRequests(),
  openMeetings: () => openMeetings(),
  openMeeting: (n) => openMeeting(n),
  openExplorations: () => openExplorations(),
  openExploration: (repo, app) => openExploration(repo, app),
  exploreNow: (repo, app) => openExploreNow(repo, app),
  movePr,
  keysHelp: toggleKeysHelp,
};
