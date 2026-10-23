import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { ago, useNow } from '@ui/time.js';
import { Patch } from './Docs.js';
import { pairsOf } from '@ui/components/Compare.js';
import { Pairs } from './Pairs.js';
import { firstName, imagePath, type Detail } from './model.js';

// A request that waits for a dev before ronin makes it (#353): a prototype
// the person approved, or a reported error's small fix (#137). Its Ahora
// (#406) shows only what the decision needs — what changes with its
// before and after, what to decide before approving, and one line of scope
// and tests — with the rest folded under Detalles, and the three
// decisions: deploy it (ronin approves its PR as whoever decides and it
// merges on green CI), make it with a review of the PR, or not do it, with
// a reason the person gets. Approving it, the dev may answer each point of
// «Antes de aprobar» (#413): the answers go in its issue, and ronin follows
// them.

type Kind = 'deploy' | 'review' | 'decline';

const SENDING: Record<Kind, string> = { deploy: 'Aprobando…', review: 'Aprobando…', decline: 'Cerrando…' };

// An older prototype has only its free-text summary: one paragraph per
// sentence or two reads better than a wall.
const paragraphs = (text: string) => text.split(/\n\s*\n|(?<=[.;])\s+(?=(?:\(\d+\)|[A-ZÁÉÍÓÚ]))/).map((p) => p.trim()).filter(Boolean);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="pd-dc-row"><div className="l">{label}</div><div>{children}</div></div>;
}

export function DevDecide({ d }: { d: Detail }) {
  const shell = useShell();
  const session = useSession();
  const queryClient = useQueryClient();
  const now = useNow();
  const [open, setOpen] = useState<Kind | null>(null);
  const [reason, setReason] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = firstName(d.person);
  const repro = d.bug?.reproductions.at(-1);
  // Approved in words only (#409): no prototype, nor its diff.
  const proto = d.worded ? undefined : d.prototypes.at(-1);
  const made = repro ?? proto;
  const team = made?.team;
  const shown = d.messages.find((m) => m.id === made?.messageId);
  const pairs = shown ? pairsOf(shown, (file) => imagePath(d.number, file)) : null;
  const canAct = session.can(d.repo, 'acciones');
  const canDeploy = canAct && session.can(d.repo, 'desplegar');
  // Since when it waits: the person's approval, or the reproduction.
  const since = d.activity.entries.flatMap((e) => (e.type === 'event' && (e.event.kind === 'decided' || e.event.kind === 'reproduced') ? [e.at] : [])).at(-1) ?? made?.at;
  // What the person asked: their first message, and what they wrote to ronin since.
  const asked = d.messages.filter((m) => m.from === 'person' && m.to !== 'team' && (m.text || m.images.length));
  const tests = [...(repro?.test ? [{ ok: repro.test.red && repro.test.green, text: `${repro.test.name}: ${repro.test.red ? 'falla sin el arreglo' : 'no falla sin el arreglo'}, ${repro.test.green ? 'pasa con él' : 'no pasa con él'}` }] : []), ...(team?.tests ?? [])];
  const passed = tests.filter((t) => t.ok).length;
  const failed = tests.length - passed;
  const scope = d.scope;
  const asks = team?.decide ?? [];
  const answered = asks.flatMap((question, i) => (answers[i]?.trim() ? [{ question, answer: answers[i].trim() }] : []));

  const send = async (kind: Kind) => {
    if (sending || (kind === 'decline' && !reason.trim())) return;
    setSending(true);
    setError(null);
    try {
      const decided = await ok(client.api.requests[':n'].decision.$post({ param: { n: String(d.number) }, json: { decision: kind, ...(kind === 'decline' ? { reason: reason.trim() } : answered.length ? { answers: answered } : {}) } }));
      queryClient.setQueryData(['request', d.number], decided);
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
      shell.toast(kind === 'decline' ? `Cerraste P-${d.number}: ${who} recibe el motivo.` : kind === 'deploy' ? `Aprobaste P-${d.number}: ronin lo hace, aprueba el PR a tu nombre y lo mergea con el CI en verde.` : `Aprobaste P-${d.number}: ronin lo hace y el PR espera la aprobación de un dev.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      setError(`No se pudo: ${(e as Error).message}`);
      setSending(false);
    }
  };

  const confirm = (kind: Kind): ReactNode => {
    if (kind === 'decline') {
      return <div className="pd-dd"><label className="field"><span>Por qué no se hace. Le llega a {who} con estas palabras, en el portal y por correo.</span>
        <textarea rows={3} maxLength={2000} autoFocus value={reason} placeholder="Por ejemplo: esa pantalla se rehace el mes que viene y el cambio entra ahí." onChange={(e) => setReason(e.target.value)} /></label>
        <div className="acts"><button className="btn-s" disabled={sending} onClick={() => setOpen(null)}>Volver</button><button className="btn-s danger-solid" disabled={sending || !reason.trim()} onClick={() => void send('decline')}>{sending ? SENDING.decline : 'No hacerlo'}</button></div></div>;
    }
    const text = kind === 'deploy'
      ? <>ronin abre el issue y el PR, <b>lo aprueba a tu nombre</b> ({session.me}) y lo mergea cuando el CI esté en verde. Sale en el próximo despliegue.</>
      : <>ronin abre el issue y el PR, que se mergea cuando un dev lo apruebe y el CI esté en verde.</>;
    const told = !asks.length ? null
      : answered.length === asks.length ? <>Con tus respuestas a «Antes de aprobar»: van en el issue y ronin las sigue.</>
        : answered.length ? <>Con tus respuestas a {answered.length} de {asks.length} puntos de «Antes de aprobar»: van en el issue y ronin las sigue. Lo demás lo hace como propuso.</>
          : <>No respondiste «Antes de aprobar»: ronin lo hace como propuso.</>;
    return <div className="pd-dd"><p>{text}</p>{told && <p className="pd-dd-ans">{told}</p>}
      <div className="acts"><button className="btn-s" disabled={sending} onClick={() => setOpen(null)}>Volver</button><button className="btn-s ok-solid" disabled={sending} onClick={() => void send(kind)}>{sending ? SENDING[kind] : kind === 'deploy' ? 'Aprobar y desplegar' : 'Aprobar con revisión'}</button></div></div>;
  };

  return (
    <div className="pd-now pd-dc"><div className="k">{canAct ? 'Ahora · te toca decidir' : 'Ahora · espera la decisión de un dev'}</div>
      <div className="t">{d.bug ? '¿Hace ronin este arreglo?' : '¿Hace ronin este cambio?'}</div>
      <div className="meta">{d.bug ? 'Arreglo chico de un error reportado' : `Ajuste chico · ${who} aprobó ${d.worded ? 'la propuesta, sin prototipo' : d.prototypes.length > 1 ? `el ${d.prototypes.length}.º prototipo` : 'el prototipo'}`}{since ? ` · espera ${ago(since, now)}` : ''}</div>

      <Row label={d.bug ? 'Qué falla' : 'Qué cambia'}>
        {d.bug ? <p>{d.bug.steps || repro?.summary}</p> : d.verdict?.proposal ? <p>{d.verdict.proposal}</p> : null}
        {pairs && <Pairs pairs={pairs} />}
      </Row>

      {asks.length ? <Row label="Antes de aprobar"><ul className="pd-dc-ask">{asks.map((x, i) => <li key={i}>{x}
        {canAct && <textarea className="pd-dc-ans" rows={1} maxLength={2000} aria-label={`Tu respuesta: ${x}`} placeholder="Tu respuesta (opcional): ronin la sigue al hacerlo"
          value={answers[i] ?? ''} disabled={sending} onChange={(e) => { const next = [...answers]; next[i] = e.target.value; setAnswers(next); }} />}
      </li>)}</ul></Row> : null}

      {(scope || tests.length > 0) && <div className="pd-dc-sum">
        {scope && <>{scope.areas.map((a) => <span key={a} className="tag">{a}</span>)}<span>{scope.files.length} {scope.files.length === 1 ? 'archivo' : 'archivos'} <span className="add">+{scope.add}</span> <span className="del">−{scope.del}</span></span></>}
        {scope && tests.length > 0 && <span className="sep">·</span>}
        {passed > 0 && <span className="okc">✓ {passed} {passed === 1 ? 'prueba' : 'pruebas'}</span>}
        {failed > 0 && <span className="warnc">! {failed} sin correr o en rojo</span>}
      </div>}

      {/* Without its parts (an older one), what to decide is in the summary: open. */}
      <details className="pd-dc-more" open={!team}><summary>Detalles: lo que pidió, {team ? 'los cambios, las pruebas, los riesgos' : 'el resumen técnico'}{made?.patch || scope ? ' y los archivos' : ''}</summary>
        {asked.length > 0 && <Row label="Lo que pidió">{asked.map((m, i) => <div key={m.id} className="pd-dc-quote">{m.text || '(solo imágenes)'}<small>{who} · {i === 0 ? 'al abrir el pedido' : 'después'}</small></div>)}</Row>}
        {team?.changes.length ? <Row label="Cambios"><ul>{team.changes.map((x, i) => <li key={i}>{x}</li>)}</ul></Row> : null}
        {tests.length > 0 && <Row label="Pruebas"><ul className="pd-dc-tests">{tests.map((t, i) => <li key={i} className={t.ok ? 'ok' : 'warn'}><span className="i">{t.ok ? '✓' : '!'}</span><span>{t.text}</span></li>)}</ul></Row>}
        {team?.risks.length ? <Row label="Riesgos"><ul>{team.risks.map((x, i) => <li key={i}>{x}</li>)}</ul></Row> : null}
        {!team && (made?.summary ?? d.verdict?.summary) && <Row label="Resumen técnico">{paragraphs(made?.summary ?? d.verdict?.summary ?? '').map((p, i) => <p key={i}>{p}</p>)}</Row>}
        {(scope || made?.patch) && <Row label="Archivos">
          {scope && <div className="pd-dc-files">{scope.files.map((f) => <div key={f.path}><span>{f.path}</span><span className="add">+{f.add}</span><span className="del">−{f.del}</span></div>)}</div>}
          {made?.patch && <div className="pd-dpatch"><Patch n={d.number} of={repro ? 'reproduction' : 'prototype'} round={made.round} /></div>}
        </Row>}
      </details>

      {!canAct ? <p className="m">Lo decide alguien con permiso para las acciones del tablero en este repo.</p>
        : open ? confirm(open)
          : <div className="acts">
            <button className="btn-s ok-solid" disabled={!canDeploy} title={canDeploy ? undefined : 'Hace falta el permiso para desplegar este repo'} onClick={() => setOpen('deploy')}>Aprobar y desplegar</button>
            <button className="btn-s primary" onClick={() => setOpen('review')}>Aprobar con revisión</button>
            <button className="btn-s danger" onClick={() => { setOpen('decline'); setReason(''); }}>No hacerlo</button>
            {asks.length ? <span className="m">Lo que respondas en «Antes de aprobar» va en el issue y ronin lo sigue; sin respuesta, lo hace como propuso.</span> : null}
          </div>}
      {error && <p className="bad">{error}</p>}
    </div>
  );
}
