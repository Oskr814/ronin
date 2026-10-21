import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { useViewState } from '@apps/dashboard/src/lib/view-state.js';
import { appKey, type Portal, type PortalChange } from './model.js';

// Agregar persona: someone of the team, before they come in; or, where
// the portal is set up, one of its accounts, invited by email.
export function AddPerson({ portal: portalData, portalFirst, onClose }: { portal: Portal | undefined; portalFirst: boolean; onClose: () => void }) {
  const shell = useShell();
  const session = useSession();
  const queryClient = useQueryClient();
  const { portalAdmin } = session;
  const [, setLink] = useViewState<Link | null>('settings.link', null);
  const [kind, setKind] = useState<'equipo' | 'portal'>(portalFirst ? 'portal' : 'equipo');
  const [login, setLogin] = useState('');
  const [role, setRole] = useState('member');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const portal = kind === 'portal';
  const ready = portal ? Boolean(name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) : Boolean(login.trim());
  const apps = portalData?.apps ?? [];
  const add = async () => {
    setSending(true);
    setError(null);
    try {
      if (!portal) {
        const out = (await ok(client.api.settings.users.$post({ json: { login, role } }))) as { login: string };
        onClose();
        shell.toast(`Agregaste a @${out.login}.`);
        shell.openSettings('usuarios', out.login);
        return;
      }
      const chosen = apps.filter((x) => grants.has(appKey(x))).map((x) => ({ repo: x.repo, app: x.app }));
      const out = (await ok(client.api['portal-admin'].users.$post({ json: { name, email, grants: chosen } }))) as PortalChange;
      onClose();
      queryClient.setQueryData(['portal-admin'], await ok(client.api['portal-admin'].$get()));
      setLink(out.sent ? { id: out.user.id, text: `Le mandamos la invitación a ${out.user.email}.` } : { id: out.user.id, text: 'La cuenta quedó, pero el correo no salió. Pásale este enlace por otro medio (vence en 24 horas):', url: out.url });
      shell.openSettings('usuarios', null, null, out.user.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      setSending(false);
      setError((e as Error).message);
    }
  };
  const enter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && ready) add();
  };
  const switchTo = (k: 'equipo' | 'portal') => {
    setKind(k);
    setError(null);
  };

  return createPortal(
    <div id="ajlayer"><div className="scrim" onClick={(event) => { if ((event.target as HTMLElement).classList.contains('scrim')) onClose(); }}><div className="dlg" role="dialog" aria-modal="true" aria-labelledby="aj-add-t">
      <h2 id="aj-add-t">Agregar persona</h2>
      {portalAdmin && <div className="aj-seg aj-kind"><button data-ajkind="equipo" aria-pressed={!portal} onClick={() => switchTo('equipo')}>Del equipo · con GitHub</button><button data-ajkind="portal" aria-pressed={portal} onClick={() => switchTo('portal')}>Usuario del portal · con correo</button></div>}
      <p className="help">{portal ? 'Le llega un correo con un enlace para crear su contraseña. Vence en 24 horas.' : 'Para darle un rol o sus permisos antes de que entre. Los repos se los sigue dando GitHub.'}</p>
      {portal ? <>
        <label className="field"><span>Nombre</span><input id="aj-add-name" ref={first} maxLength={120} autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={enter} /></label>
        <label className="field"><span>Correo</span><input id="aj-add-email" type="email" autoComplete="off" value={email} placeholder="persona@gmail.com" onChange={(event) => setEmail(event.target.value)} onKeyDown={enter} /></label>
        <fieldset className="aj-add-apps"><legend>Puede pedir ajustes en</legend>{apps.length ? apps.map((x) => (
          <label key={appKey(x)} className="aj-chk"><input type="checkbox" data-ajaddgrant={appKey(x)} checked={grants.has(appKey(x))} onChange={(event) => {
            const next = new Set(grants);
            if (event.target.checked) next.add(appKey(x));
            else next.delete(appKey(x));
            setGrants(next);
          }} /><span>{x.org} · {x.name}</span></label>
        )) : <span className="m">Ningún repo tiene portal.apps en repos.json.</span>}</fieldset>
      </> : <>
        <label className="field"><span>Login de GitHub</span><input id="aj-add-login" ref={first} autoComplete="off" value={login} placeholder="usuario" onChange={(event) => setLogin(event.target.value)} onKeyDown={enter} /></label>
        <label className="field"><span>Rol</span><select id="aj-add-role" value={role} onChange={(event) => setRole(event.target.value)}><option value="member">Miembro</option><option value="admin">Administrador</option></select></label>
      </>}
      <p className="bad" hidden={!error}>{error ?? ''}</p>
      <div className="foot-d"><button className="btn-s" data-ajaddx onClick={onClose}>Cancelar</button><button className="btn-s primary" data-ajaddok disabled={sending || !ready} onClick={add}>{sending ? 'Agregando…' : portal ? 'Crear e invitar' : 'Agregar'}</button></div>
    </div></div></div>,
    document.body,
  );
}

// What the last change to a portal account left to say: a link that didn't
// go out by email, to pass on. Kept while the person goes to its page.
export interface Link { id: string; text: string; url?: string }
