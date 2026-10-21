import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, client, ok } from '../../api.js';
import { useRepoColor, useSession, useShell } from '../../shell/hooks.js';
import { useViewState } from '../../lib/view-state.js';
import { short } from '../../../../../ui/time.js';
import { AddPerson } from './AddPerson.js';
import { onCommit, Row, Sec, SectionLink, Switch, useChange } from './parts.js';
import { appLabel, EVENTS, PERMS, portalStatus, repoShort, setName, SETS, type Person, type SetName, type Team, type User as UserData } from './model.js';
import type { Data } from './Settings.js';

// Ajustes → Usuarios (#174, stage 2): the team, their role and what each
// can do repo by repo, never more than GitHub gives; and the portal's
// accounts (stage 3), with the role Usuario.

export const since = (iso: string | undefined) => (iso ? `hace ${short(Date.now() - Date.parse(iso))}` : 'nunca');
const AdminPill = ({ u }: { u: Person }) => (u.role === 'admin' ? <><span className="aj-pill admin">Administrador</span>{u.envAdmin ? <> <span className="aj-env" title="DASHBOARD_ADMINS">.env</span></> : null}</> : <span className="aj-pill">Miembro</span>);

export function Users({ data }: { data: Data }) {
  const shell = useShell();
  const repoColor = useRepoColor();
  const session = useSession();
  const queryClient = useQueryClient();
  const change = useChange();
  const { portalAdmin } = session;
  const [q, setQ] = useViewState('settings.q', '');
  const [adding, setAdding] = useState(false);
  const d = data.team;
  if (!d) return <><h1>Usuarios</h1><div className="empty">Cargando…</div></>;
  const portalData = data.portal;
  const query = q.trim().toLowerCase();
  const people = d.people.filter((u) => !query || `${u.login} ${u.name ?? ''} ${u.email ?? ''}`.toLowerCase().includes(query));
  const repos = (u: Team['people'][number]) => (u.role === 'admin' ? <span className="m">Todos</span> : (() => {
    const shown = u.repos.filter((r) => r.github);
    return shown.length ? shown.map((r) => {
      const label = r.hidden ? 'oculto' : setName(r.set, d.porDefecto) + (r.set ? '' : '*') + (r.desplegar ? ' + desplegar' : '');
      return <span key={r.repo} className={`aj-rp${r.hidden ? ' off' : ''}`}><i style={{ background: repoColor(r.repo) }} />{repoShort(r.repo)} <span className="m">{label}</span></span>;
    }) : <span className="m">Ninguno en GitHub</span>;
  })());
  const env = d.envAllowed.length ? `.env dice: ${d.envAllowed.join(', ')}` : 'hoy vacío';
  const portal = portalAdmin ? (portalData?.users ?? []).filter((u) => !query || `${u.name} ${u.email}`.toLowerCase().includes(query)) : [];
  const f = portalAdmin ? data.filter : 'equipo';
  const open = (login: string) => shell.openSettings('usuarios', login);
  const openAccount = (id: string) => shell.openSettings('usuarios', null, null, id);
  const teamRows = people.map((u) => (
    <tr key={`t${u.login}`} data-ajuser={u.login} tabIndex={0} onClick={() => open(u.login)} onKeyDown={(event) => { if (event.key === 'Enter') open(u.login); }}>
      <td><b>{u.name || u.login}</b><small><span className="mono">@{u.login}</span>{u.email ? null : <> · <span className="warn-t">sin correo</span></>}</small></td>
      <td><AdminPill u={u} /><small>GitHub</small></td>
      <td className="hide-m">{repos(u)}</td>
      <td className="hide-m m">{since(u.lastSeenAt)}{u.addedBy ? <small>agregado por @{u.addedBy}</small> : null}</td>
    </tr>
  ));
  const portalRows = portal.map((u) => {
    const [cls, label] = portalStatus(u);
    return (
      <tr key={`p${u.id}`} data-ajcuenta={u.id} tabIndex={0} className={u.disabled ? 'off' : ''} onClick={() => openAccount(u.id)} onKeyDown={(event) => { if (event.key === 'Enter') openAccount(u.id); }}>
        <td><b>{u.name}</b><small>{u.email}</small></td>
        <td><span className="aj-pill user">Usuario</span><small>Portal{cls === 'ok' ? '' : <> · <span className={cls === 'warn' ? 'warn-t' : 'm'}>{label}</span></>}</small></td>
        <td className="hide-m">{u.grants.length ? u.grants.map((g) => <span key={`${g.repo}:${g.app}`} className="aj-rp"><i style={{ background: repoColor(g.repo) }} />{appLabel(portalData?.apps, g)}</span>) : <span className="m">ninguna app</span>}{u.today && !u.disabled ? <small>quedan {Math.max(0, u.today.limit - u.today.used)} de {u.today.limit} pedidos hoy</small> : null}</td>
        <td className="hide-m m">{u.lastLoginAt ? since(u.lastLoginAt) : 'nunca'}<small>invitada por @{u.createdBy}</small></td>
      </tr>
    );
  });
  const rows = f === 'equipo' ? teamRows : f === 'portal' ? portalRows : [...teamRows, ...portalRows];
  const counts: Record<string, number> = { todos: d.people.length + (portalData?.users.length ?? 0), equipo: d.people.length, portal: portalData?.users.length ?? 0 };
  const filter = portalAdmin ? <div className="aj-seg">{[['todos', 'Todos'], ['equipo', 'Equipo'], ['portal', 'Portal']].map(([k, n]) => <button key={k} data-ajf={k} aria-pressed={f === k} onClick={() => data.chooseFilter(k)}>{n} <span className="m">{counts[k]}</span></button>)}</div> : null;
  const team = (patch: { entrada?: string; porDefecto?: string }) => change(async () => {
    const out = (await ok(client.api.settings.team.$post({ json: patch }))) as Partial<Team>;
    queryClient.setQueryData<Team>(['settings', 'users'], (x) => x && { ...x, ...out, entradaSet: true });
    shell.toast('Guardado.');
  });
  return <>
    <h1>Usuarios</h1><p className="lead">Todos los que usan ronin. <b>Administradores</b> y <b>miembros</b> son el equipo y entran al tablero con GitHub: GitHub dice qué repos ve cada uno (permiso <i>triage</i> o más); aquí se le pueden quitar repos y limitar qué hace en ellos, nunca darle más.{portalAdmin ? <> <b>Usuarios</b> son quienes piden ajustes en el portal, con correo y contraseña: solo ven las apps que se les habilitan.</> : null}</p>
    {f === 'portal' ? null : (
      <Sec title="Quién del equipo puede entrar">
        <Row label="Entrada" desc={d.entrada === 'github' ? 'Cualquiera con triage en algún repo de ronin. Entra como miembro, con los permisos por defecto.' : 'Solo las personas de la lista de abajo y los administradores.'}
          ctl={<div className="aj-seg"><button data-ajentrada="github" aria-pressed={d.entrada === 'github'} onClick={() => team({ entrada: 'github' })}>Quien tenga acceso en GitHub</button><button data-ajentrada="lista" aria-pressed={d.entrada === 'lista'} onClick={() => team({ entrada: 'lista' })}>Solo la lista</button></div>}
          src={<><span>{d.entradaSet ? 'Reemplaza a' : 'Hoy lo dice'}</span><code>DASHBOARD_ALLOWED_USERS</code><span>· {env}</span></>} />
        <Row label="Permisos por defecto" desc="Los de un miembro en cada repo, si no se le eligieron otros. Desplegar se da aparte, repo por repo."
          ctl={<select className="aj-in" data-ajdef aria-label="Permisos por defecto" defaultValue={d.porDefecto} ref={onCommit((el) => team({ porDefecto: el.value }))}>{Object.entries(SETS).map(([id, [name, desc]]) => <option key={id} value={id}>{name} ({desc})</option>)}</select>} />
      </Sec>
    )}
    <div className="aj-bar">{filter}<input className="aj-in" data-ajq placeholder="Buscar por nombre, login o correo" value={q} onChange={(event) => setQ(event.target.value)} aria-label="Buscar" /><button className="btn-s primary" data-ajadd onClick={() => setAdding(true)}>Agregar persona</button></div>
    <div className="aj-card"><table className="aj-tbl"><thead><tr><th>Persona</th><th>Rol</th><th className="hide-m">{f === 'portal' ? 'Apps' : 'Repos'}</th><th className="hide-m">Entró</th></tr></thead><tbody>
      {rows.length ? rows : <tr><td colSpan={4} className="m">Nadie con esa búsqueda.</td></tr>}
    </tbody></table></div>
    <p className="aj-foot">Del equipo aparece quien entró alguna vez o agregó un administrador; * = los permisos por defecto.{portalAdmin ? ' Las cuentas del portal existen solo si alguien las invita.' : ''}</p>
    {adding && <AddPerson portal={portalData} portalFirst={portalAdmin && f === 'portal'} onClose={() => setAdding(false)} />}
  </>;
}

// One of the team: their role, their name and email, and what they can do
// in each repo.
export function User({ data, login }: { data: Data; login: string }) {
  const shell = useShell();
  const repoColor = useRepoColor();
  const session = useSession();
  const queryClient = useQueryClient();
  const change = useChange();
  const crumbs = <div className="aj-crumbs"><SectionLink to="usuarios">Usuarios</SectionLink> › <span>{login}</span></div>;
  const u = data.user;
  if (!u) return <>{crumbs}<div className="empty">Cargando…</div></>;
  const admin = u.role === 'admin';
  const me = u.login === session.me;
  const save = (patch: Record<string, unknown>) => change(async () => {
    const next = (await ok(client.api.settings.users[':login'].$post({ param: { login }, json: patch }))) as unknown as UserData;
    queryClient.setQueryData(['settings', 'user', login], next);
    shell.toast('Guardado.');
  });
  const role = (r: 'admin' | 'member') => {
    if (u.role === r) return;
    if (r === 'admin' && !confirm(`¿Hacer administrador a ${u.name || login}? Va a ver todos los repos, aunque GitHub no se los dé, y a poder cambiar todos los ajustes.`)) return;
    save({ role: r });
  };
  const remove = async () => {
    if (!confirm(`¿Quitar a ${u.name || login} de la lista?`)) return;
    try {
      await ok(client.api.settings.users[':login'].remove.$post({ param: { login } }));
      shell.toast(`Quitaste a @${login} de la lista.`);
      shell.openSettings('usuarios');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return shell.unauthorized(error.message);
      shell.toast(`No se pudo. ${(error as Error).message}`);
    }
  };
  const roleSeg = <div className="aj-seg"><button data-ajrole="admin" aria-pressed={admin} disabled={u.envAdmin} onClick={() => role('admin')}>Administrador</button><button data-ajrole="member" aria-pressed={!admin} disabled={u.envAdmin || me} onClick={() => role('member')}>Miembro</button></div>;
  const repoCard = (r: UserData['repos'][number]) => {
    const name = <b><i style={{ background: repoColor(r.repo) }} />{r.repo}</b>;
    if (r.githubLets === false || r.github === null) return <div key={r.repo} className="aj-card aj-repo off"><div className="aj-row"><div className="l">{name}<small>GitHub no le da acceso (triage o más). Se le da en GitHub, no aquí.</small></div></div></div>;
    const custom = r.set === 'custom';
    return (
      <div key={r.repo} className={`aj-card aj-repo${r.hidden ? ' off' : ''}`}><div className="aj-row"><div className="l">{name}<small>GitHub: {r.github ?? 'no se pudo leer'}{r.hidden ? <> · <span className="warn-t">oculto en el tablero</span></> : null}</small></div>
        <div className="ctl"><select className="aj-in" data-ajset={r.repo} disabled={r.hidden} aria-label={`Permisos en ${r.repo}`} defaultValue={r.set ?? ''} ref={onCommit((el) => {
          if (el.value !== 'custom') save({ repo: { repo: r.repo, set: el.value || null } });
        })}><option value="">Por defecto ({SETS[u.porDefecto as SetName]?.[0] ?? 'Todo'})</option>{Object.entries(SETS).map(([id, [n]]) => <option key={id} value={id}>{n}</option>)}{custom ? <option value="custom">Personalizado</option> : null}</select>
          <Switch on={!r.hidden} data-ajhide={r.repo} title={r.hidden ? 'Mostrarle este repo' : 'Ocultarle este repo'} label={`Ve ${r.repo} en el tablero`} onToggle={() => save({ repo: { repo: r.repo, hidden: !r.hidden } })} /></div></div>
        {r.hidden ? null : <div className="aj-perm">{PERMS.map(([id, n, hint]) => (
          <label key={id} title={hint}><input type="checkbox" data-ajperm={r.repo} data-p={id} defaultChecked={r.perms[id]} onChange={(event) => {
            const checked = event.target.checked;
            if (id === 'desplegar') return save({ repo: { repo: r.repo, desplegar: checked } });
            save({ repo: { repo: r.repo, custom: { notas: r.perms.notas, aprobar: r.perms.aprobar, acciones: r.perms.acciones, [id]: checked } } });
          }} /><span>{n}<small>{hint}</small></span></label>
        ))}</div>}</div>
    );
  };
  return <>
    {crumbs}<h1>{u.name || u.login}</h1><p className="lead"><span className="mono">@{u.login}</span> · entró {since(u.lastSeenAt)}{u.addedBy ? ` · agregado por @${u.addedBy}` : ''}</p>
    <Sec title="Cuenta">
      <Row label="Rol" desc={admin ? 'Ve todos los repos, hace todo y administra los ajustes.' : 'Ve lo que GitHub le da, con los permisos de cada repo.'} ctl={roleSeg}
        src={u.envAdmin ? <><span className="aj-env">.env</span><code>DASHBOARD_ADMINS</code><span>· administrador de respaldo: no se le quita desde aquí, para que nadie quede afuera por un error.</span></> : me && admin ? <span>No puedes quitarte el rol a ti mismo.</span> : null} />
      <Row label="Nombre" desc="Lo pone la persona en su perfil; un administrador puede corregirlo." ctl={<input className="aj-in" maxLength={120} data-ajufield="name" defaultValue={u.name ?? ''} placeholder={u.login} aria-label="Nombre" ref={onCommit((el) => save({ name: el.value }))} />} />
      <Row label="Correo" ctl={<input className="aj-in" type="email" maxLength={254} data-ajufield="email" defaultValue={u.email ?? ''} placeholder="persona@gmail.com" aria-label="Correo" ref={onCommit((el) => save({ email: el.value }))} />} />
    </Sec>
    {admin ? <Sec title="Repos">{u.repos.map((r) => <Row key={r.repo} label={<><i className="aj-sq" style={{ background: repoColor(r.repo) }} />{r.repo}</>} desc="Todo, como administrador." ctl={<span className="aj-pill">GitHub: {r.github ?? '—'}</span>} />)}</Sec>
      : <section className="aj-sec"><h2>Repos y permisos</h2><p className="aj-d">Un conjunto marca los permisos; tocar uno lo deja como <i>Personalizado</i>. Desplegar se da aparte.</p>{u.repos.map(repoCard)}</section>}
    <Sec title="Notificaciones" lead={u.email ? 'Las elige la persona en su perfil; aquí solo se ven.' : <span className="warn-t">Sin correo: no le llega nada hasta que tenga uno.</span>}>
      {u.notificaciones.map((n) => <Row key={n.repo} label={<><i className="aj-sq" style={{ background: repoColor(n.repo) }} />{n.repo}</>} desc={n.events.length ? EVENTS.filter(([id]) => n.events.includes(id)).map(([, name]) => name).join(' · ') : 'Ninguna'} ctl={<span className="m">{n.events.length} de {EVENTS.length}{n.chosen ? '' : ', las de antes'}</span>} />)}
    </Sec>
    {u.envAdmin || me ? null : <section className="aj-sec"><button className="btn-s danger" data-ajremove onClick={remove}>Quitar de la lista</button><p className="aj-foot">{u.entrada === 'lista' ? 'Con la entrada en "solo la lista", deja de poder entrar.' : 'Si vuelve a entrar, tiene lo que le da GitHub y los permisos por defecto.'}</p></section>}
  </>;
}
