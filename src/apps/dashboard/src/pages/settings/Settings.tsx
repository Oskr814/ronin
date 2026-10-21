import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { type SettingsView, useSession, useSettingsView, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { Accounts } from './Accounts.js';
import { Connections, Log } from './Connections.js';
import { Notifications, Profile } from './Profile.js';
import { Account } from './PortalAccount.js';
import { Repo, RepoList } from './Repos.js';
import { User, Users } from './Users.js';
import { Agents, Exploration, General, Previews } from './Values.js';
import { useViewState } from '@apps/dashboard/src/lib/view-state.js';
import { ChangeContext, makeChange } from './parts.js';
import type { Accounts as AccountsData, Connections as ConnectionsData, LogEntry, Page, Portal, Repos, Team, User as UserData } from './model.js';

// Ajustes (#174): one page per section, like Linear's settings; each field
// saves when it's left. The shell draws its sidebar (Tu cuenta, and
// Administración for admins), routes /ajustes/<sección>[/…] and mounts the
// page again on each address, which reads it from useSettingsView(): so,
// as before, going to a section reads it again.

// What a section reads, besides the page's own data.
export interface Data {
  view: SettingsView;
  log?: LogEntry[];
  repos?: Repos;
  connections?: ConnectionsData;
  accounts?: AccountsData;
  team?: Team;
  user?: UserData;
  portal?: Portal;
  portalError?: string;
  // Usuarios' filter (todos, equipo, portal): the one the shell was asked for
  // (Pedidos del portal asks for the portal's), or the last one chosen.
  filter: string;
  chooseFilter(filter: string): void;
}

export function Settings() {
  const shell = useShell();
  const session = useSession();
  const settingsView = useSettingsView();
  const [view] = useState(() => settingsView);
  const portalAdmin = session.portalAdmin;
  const { section: sec, login, account } = view;
  // Bumped after each change: the section is drawn again from what's saved.
  const [rev, setRev] = useState(0);
  const [kept, keep] = useViewState('settings.filter', 'todos');
  const [chosen, setChosen] = useState(false);
  useEffect(() => {
    if (view.filter) keep(view.filter);
  }, []);
  const filter = chosen ? kept : view.filter ?? kept;
  const chooseFilter = (f: string) => {
    setChosen(true);
    keep(f);
  };
  const change = useMemo(() => makeChange(shell.unauthorized, shell.toast, () => setRev((n) => n + 1)), [shell]);

  const main = useQuery({ queryKey: ['settings'], queryFn: () => ok(client.api.settings.$get()) as Promise<unknown> as Promise<Page> });
  const ready = Boolean(main.data);
  const log = useQuery({ queryKey: ['settings', 'log'], enabled: ready && sec === 'registro', queryFn: () => ok(client.api.settings.log.$get()).then((d) => (d as { registro: LogEntry[] }).registro) });
  const repos = useQuery({ queryKey: ['settings', 'repos'], enabled: ready && sec === 'repos', queryFn: () => ok(client.api.settings.repos.$get()) as Promise<unknown> as Promise<Repos> });
  const connections = useQuery({ queryKey: ['settings', 'connections'], enabled: ready && sec === 'conexiones', queryFn: () => ok(client.api.settings.connections.$get()) as Promise<unknown> as Promise<ConnectionsData> });
  const accounts = useQuery({ queryKey: ['settings', 'accounts'], enabled: ready && sec === 'cuentas', queryFn: () => ok(client.api.settings.accounts.$get()) as Promise<unknown> as Promise<AccountsData> });
  const user = useQuery({ queryKey: ['settings', 'user', login], enabled: ready && sec === 'usuarios' && Boolean(login), queryFn: () => ok(client.api.settings.users[':login'].$get({ param: { login: login! } })) as Promise<unknown> as Promise<UserData> });
  const team = useQuery({ queryKey: ['settings', 'users'], enabled: ready && sec === 'usuarios' && !login && !account, queryFn: () => ok(client.api.settings.users.$get()) as Promise<unknown> as Promise<Team> });
  // The portal's accounts (role Usuario), when the portal is set up.
  const portal = useQuery({ queryKey: ['portal-admin'], enabled: ready && sec === 'usuarios' && !login && portalAdmin, queryFn: () => ok(client.api['portal-admin'].$get()) as Promise<unknown> as Promise<Portal> });

  const queries = [main, log, repos, connections, accounts, user, team, portal];
  const error = queries.find((q) => q.error)?.error;
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) shell.unauthorized(error.message);
  }, [error, shell]);

  const d = main.data;
  const data: Data = { view, log: log.data, repos: repos.data, connections: connections.data, accounts: accounts.data, team: team.data, user: user.data, portal: portal.data, portalError: portal.error?.message, filter, chooseFilter };
  let body: ReactNode;
  if (!d) body = error && !(error instanceof ApiError && error.status === 401) ? <p className="bad">{error.message}</p> : <div className="empty">Cargando…</div>;
  else body = <Section key={rev} d={d} data={data} />;
  return (
    <ChangeContext.Provider value={change}>
      <div className="today aj"><div className="aj-col">{body}</div></div>
    </ChangeContext.Provider>
  );
}

function Section({ d, data }: { d: Page; data: Data }) {
  const { section, login, repo, account } = data.view;
  switch (section) {
    case 'notificaciones': return <Notifications d={d} />;
    case 'general': return <General d={d} />;
    case 'repos': return repo ? <Repo data={data} repo={repo} /> : <RepoList data={data} />;
    case 'agentes': return <Agents d={d} />;
    case 'cuentas': return <Accounts data={data} />;
    case 'exploracion': return <Exploration d={d} />;
    case 'previews': return <Previews d={d} />;
    case 'conexiones': return <Connections data={data} />;
    case 'usuarios': return account ? <Account data={data} id={account} /> : login ? <User data={data} login={login} /> : <Users data={data} />;
    case 'registro': return <Log data={data} />;
    default: return <Profile d={d} />;
  }
}
