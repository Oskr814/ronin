import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { Patch, Thumbs } from './Docs.js';
import { firstName, ICON, type Detail } from './model.js';

// A request that waits for a dev before ronin makes it (#353): a prototype
// the person approved, or a reported error's small fix (#137). Its Ahora
// shows what would be made, and the three decisions: deploy it (ronin
// approves its PR as whoever decides and it merges on green CI), make it
// with a review of the PR, or not do it, with a reason the person gets.

type Kind = 'deploy' | 'review' | 'decline';

const SENDING: Record<Kind, string> = { deploy: 'Aprobando…', review: 'Aprobando…', decline: 'Cerrando…' };

export function DevDecide({ d }: { d: Detail }) {
  const shell = useShell();
  const session = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<Kind | null>(null);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = firstName(d.person);
  const repro = d.bug?.reproductions.at(-1);
  const proto = d.prototypes.at(-1);
  const shown = d.messages.find((m) => m.id === (repro ?? proto)?.messageId);
  const canAct = session.can(d.repo, 'acciones');
  const canDeploy = canAct && session.can(d.repo, 'desplegar');

  const send = async (kind: Kind) => {
    if (sending || (kind === 'decline' && !reason.trim())) return;
    setSending(true);
    setError(null);
    try {
      const decided = await ok(client.api.requests[':n'].decision.$post({ param: { n: String(d.number) }, json: { decision: kind, ...(kind === 'decline' ? { reason: reason.trim() } : {}) } }));
      queryClient.setQueryData(['request', d.number], decided);
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
      shell.toast(kind === 'decline' ? `Cerraste P-${d.number}: ${who} recibe el motivo.` : kind === 'deploy' ? `Aprobaste P-${d.number}: ronin lo hace, aprueba el PR a tu nombre y lo mergea con el CI en verde.` : `Aprobaste P-${d.number}: ronin lo hace y el PR espera la aprobación de un dev.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      setError(`No se pudo: ${(e as Error).message}`);
      setSending(false);
    }
  };

  const what: ReactNode = d.bug
    ? <>
      <div className="d">ronin reprodujo el error con un test que falla{repro?.test?.green ? ' y un arreglo chico lo pasó a verde' : ''}. {who} no aprueba nada.</div>
      {repro?.summary && <><h4>Causa</h4><p>{repro.summary}</p></>}
      {repro?.test && <p className="m">Test: <code>{repro.test.name}</code>{repro.test.file && <> en <code>{repro.test.file}</code></>}</p>}
    </>
    : <>
      <div className="d">{who} aprobó el prototipo{d.prototypes.length > 1 ? ` (después de ${d.prototypes.length - 1} ${d.prototypes.length === 2 ? 'ajuste' : 'ajustes'})` : ''}. ronin lo clasificó como un ajuste chico.</div>
      {d.verdict?.proposal && <><h4>Qué cambia</h4><p>{d.verdict.proposal}</p></>}
      {proto?.summary && <><h4>Lo que cambia el prototipo</h4><p>{proto.summary}</p></>}
    </>;

  const confirm = (kind: Kind): ReactNode => {
    if (kind === 'decline') {
      return <div className="pd-dd"><label className="field"><span>Por qué no se hace. Le llega a {who} con estas palabras, en el portal y por correo.</span>
        <textarea rows={3} maxLength={2000} autoFocus value={reason} placeholder="Por ejemplo: esa pantalla se rehace el mes que viene y el cambio entra ahí." onChange={(e) => setReason(e.target.value)} /></label>
        <div className="acts"><button className="btn-s" disabled={sending} onClick={() => setOpen(null)}>Volver</button><button className="btn-s danger-solid" disabled={sending || !reason.trim()} onClick={() => void send('decline')}>{sending ? SENDING.decline : 'No hacerlo'}</button></div></div>;
    }
    const text = kind === 'deploy'
      ? <>ronin abre el issue y el PR, <b>lo aprueba a tu nombre</b> ({session.me}) y lo mergea cuando el CI esté en verde. Sale en el próximo despliegue.</>
      : <>ronin abre el issue y el PR, que se mergea cuando un dev lo apruebe y el CI esté en verde.</>;
    return <div className="pd-dd"><p>{text}</p>
      <div className="acts"><button className="btn-s" disabled={sending} onClick={() => setOpen(null)}>Volver</button><button className="btn-s ok-solid" disabled={sending} onClick={() => void send(kind)}>{sending ? SENDING[kind] : kind === 'deploy' ? 'Aprobar y desplegar' : 'Aprobar con revisión'}</button></div></div>;
  };

  return (
    <div className="pd-now waiting"><div className="k">{ICON.wait} Ahora</div>
      <div className="t">{d.bug ? 'Espera que el equipo decida si ronin hace el arreglo' : 'Espera que el equipo decida si ronin hace el cambio'}</div>
      {what}
      {shown && <Thumbs d={d} m={shown} />}
      {(repro?.patch || proto?.patch) && <div className="pd-dpatch"><Patch n={d.number} of={repro ? 'reproduction' : 'prototype'} round={(repro ?? proto)!.round} /></div>}
      {!canAct ? <p className="m">Lo decide alguien con permiso para las acciones del tablero en este repo.</p>
        : open ? confirm(open)
          : <div className="acts">
            <button className="btn-s ok-solid" disabled={!canDeploy} title={canDeploy ? undefined : 'Hace falta el permiso para desplegar este repo'} onClick={() => setOpen('deploy')}>Aprobar y desplegar</button>
            <button className="btn-s primary" onClick={() => setOpen('review')}>Aprobar con revisión</button>
            <button className="btn-s danger" onClick={() => { setOpen('decline'); setReason(''); }}>No hacerlo</button>
          </div>}
      {error && <p className="bad">{error}</p>}
    </div>
  );
}
