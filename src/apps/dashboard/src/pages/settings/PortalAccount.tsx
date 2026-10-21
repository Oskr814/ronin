import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { client, ok } from '../../api.js';
import { useRepoColor, useShell } from '../../shell/hooks.js';
import { useViewState } from '../../lib/view-state.js';
import type { Link } from './AddPerson.js';
import { onCommit, Row, Sec, SectionLink, useChange } from './parts.js';
import { appKey, appLabel, portalStatus, type Portal, type PortalChange } from './model.js';
import { since } from './Users.js';
import type { Data } from './Settings.js';

// One of the portal's accounts (#174, stage 3), as Pedidos del portal →
// Usuarios had it in a dialog: its name, the apps it can ask in, its daily
// limit, the link to set its password and turning it off.
export function Account({ data, id }: { data: Data; id: string }) {
  const shell = useShell();
  const repoColor = useRepoColor();
  const queryClient = useQueryClient();
  const change = useChange();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useViewState<Link | null>('settings.link', null);
  const linkBox = useRef<HTMLInputElement>(null);
  useEffect(() => linkBox.current?.select(), []);
  const crumbs = <div className="aj-crumbs"><SectionLink to="usuarios">Usuarios</SectionLink> › <span>Portal</span></div>;
  const portal = data.portal;
  const u = portal?.users.find((x) => x.id === id);
  if (!portal) return <>{crumbs}<div className="empty">{data.portalError ?? 'Cargando…'}</div></>;
  if (!u) return <>{crumbs}<p className="bad">No existe esa cuenta.</p></>;

  // A change to the account: the page shows what happened.
  const write = async (body: Record<string, unknown>, sendLink = false) => {
    setBusy(true);
    await change(async () => {
      const out = (await ok(sendLink
        ? client.api['portal-admin'].users[':id'].link.$post({ param: { id } })
        : client.api['portal-admin'].users[':id'].$post({ param: { id }, json: body }))) as PortalChange;
      queryClient.setQueryData<Portal>(['portal-admin'], (p) => p && { ...p, users: [...p.users.filter((x) => x.id !== out.user.id), { ...out.user, today: p.users.find((x) => x.id === out.user.id)?.today }].sort((a, b) => a.name.localeCompare(b.name, 'es')) });
      if (out.sent === true) setLink({ id: out.user.id, text: `Le mandamos el enlace a ${out.user.email}.` });
      else if (out.sent === false) setLink({ id: out.user.id, text: 'El correo no salió. Pásale este enlace por otro medio (vence en 24 horas):', url: out.url });
      else shell.toast(body.disabled === true ? 'Cuenta desactivada.' : body.disabled === false ? 'Cuenta reactivada.' : 'Guardado.');
      // The limit and today's use come with the list.
      if (body.dailyLimit !== undefined) queryClient.setQueryData(['portal-admin'], await ok(client.api['portal-admin'].$get()));
    });
    setBusy(false);
  };

  const [cls, label] = portalStatus(u);
  const byRepo = [...new Set(portal.apps.map((a) => a.repo))].map((repo) => portal.apps.filter((a) => a.repo === repo));
  const granted = new Set(u.grants.map(appKey));
  const gone = u.grants.filter((g) => !portal.apps.some((a) => appKey(a) === appKey(g)));
  const shown = link?.id === u.id ? link : null;
  const grant = (key: string, on: boolean) => {
    const keys = new Set([...granted].filter((k) => portal.apps.some((a) => appKey(a) === k)));
    if (on) keys.add(key);
    else keys.delete(key);
    // Apps no longer in the portal stay as they are.
    write({ grants: [...gone, ...portal.apps.filter((a) => keys.has(appKey(a))).map((a) => ({ repo: a.repo, app: a.app }))] });
  };
  return <>
    {crumbs}<h1>{u.name}</h1><p className="lead">{u.email} · invitada por @{u.createdBy} · entró {u.lastLoginAt ? since(u.lastLoginAt) : 'nunca'}</p>
    {cls !== 'ok' ? <div className={`aj-note ${cls === 'warn' || cls === 'crit' ? 'warn' : ''}`}><b>{label[0].toUpperCase() + label.slice(1)}.</b> {u.disabled ? 'No puede entrar al portal; sus pedidos siguen en Pedidos del portal.' : 'Todavía no creó su contraseña.'}</div> : null}
    {shown ? <div className={`aj-note${shown.url ? ' warn' : ''}`}>{shown.text}{shown.url ? <input className="aj-in aj-link" ref={linkBox} readOnly value={shown.url} aria-label="Enlace" /> : null}</div> : null}
    <Sec title="Cuenta">
      <Row label="Rol" desc="Pide ajustes en el portal con su correo y contraseña. No entra al tablero." ctl={<span className="aj-pill user">Usuario</span>} />
      <Row label="Nombre" ctl={<input className="aj-in" maxLength={120} data-ajcname defaultValue={u.name} aria-label="Nombre" ref={onCommit((el) => write({ name: el.value }))} />} />
      <Row label="Correo" desc="Es con lo que entra: no se cambia. Si cambió de correo, se invita de nuevo." ctl={<span className="aj-ro">{u.email}</span>} />
    </Sec>
    <Sec title="Puede pedir ajustes en" lead={<>Las apps de <code>portal.apps</code> de cada repo.</>}>
      {byRepo.map((apps) => (
        <div key={apps[0].repo} className="aj-row aj-apps"><div className="l"><b><i className="aj-sq" style={{ background: repoColor(apps[0].repo) }} />{apps[0].org} <span className="m mono">{apps[0].repo}</span></b>
          {apps.map((a) => <label key={a.app} className="aj-chk"><input type="checkbox" data-ajgrant={appKey(a)} defaultChecked={granted.has(appKey(a))} onChange={(event) => grant(appKey(a), event.target.checked)} /><span>{a.name}{a.description ? <small>{a.description}</small> : null}</span></label>)}</div></div>
      ))}
      {gone.length ? <div className="aj-row"><div className="l"><small>{gone.map((g) => appLabel(portal.apps, g)).join(', ')}: ya no está en el portal (portal.apps de repos.json).</small></div></div> : null}
    </Sec>
    <Sec title="Pedidos">
      <Row label="Pedidos por día" desc={`Vacío: el de General (${portal.dailyLimit}).`} ctl={<><input className="aj-num" type="number" min="0" max="100" data-ajclimit defaultValue={u.dailyLimit ?? ''} placeholder={String(portal.dailyLimit)} aria-label="Pedidos por día" ref={onCommit((el) => {
        const raw = el.value.trim();
        write({ dailyLimit: raw === '' ? null : Number(raw) });
      })} /><span className="aj-unit">pedidos</span></>}
        src={u.today ? <span>Hoy: {u.today.used} de {u.today.limit}{u.today.used >= u.today.limit ? <> · <span className="warn-t">sin pedidos hasta mañana</span></> : null}</span> : null} />
      <Row label="Sus pedidos" ctl={<button className="btn-s" data-ajcpedidos onClick={() => shell.openRequests()}>Ver en Pedidos del portal</button>} />
    </Sec>
    <Sec title="Acceso">
      <Row label={u.hasPassword ? 'Nueva contraseña' : 'Volver a mandar la invitación'} desc="Le llega un enlace que vence en 24 horas. Nadie más ve la contraseña." ctl={<button className="btn-s" data-ajclink disabled={u.disabled || busy} onClick={() => write({}, true)}>Mandar enlace</button>} />
      <Row label={u.disabled ? 'Reactivar' : 'Desactivar'} desc={u.disabled ? 'Vuelve a poder entrar con su contraseña.' : 'Cierra sus sesiones al momento. Sus pedidos no se tocan.'} ctl={<button className={`btn-s${u.disabled ? '' : ' danger'}`} data-ajcoff disabled={busy} onClick={() => {
        if (!u.disabled && !confirm(`¿Desactivar la cuenta de ${u.name}? Sus sesiones se cierran al momento.`)) return;
        write({ disabled: !u.disabled });
      }}>{u.disabled ? 'Reactivar' : 'Desactivar'}</button>} />
    </Sec>
  </>;
}
