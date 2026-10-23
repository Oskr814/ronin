import type { ReactNode } from 'react';
import { useShell } from '@apps/dashboard/src/shell/hooks.js';
import { hhmm, when } from '@apps/dashboard/src/lib/format.js';
import { Dot, RunCard, runTitle, typeName } from '@apps/dashboard/src/lib/runs.js';
import { ago, short, useNow } from '@ui/time.js';
import { DevDecide } from './DevDecide.js';
import { TeamClose } from './TeamClose.js';
import { useActions, Interview, Thumbs } from './Docs.js';
import { firstName, ICON, REPRODUCTIONS, STATUS, type Detail, type Entry, type RequestEvent } from './model.js';

// A request's Actividad: what it waits on now, and everything that
// happened to it, oldest first.

const TEST: Record<string, string> = { red: 'test en rojo', green: 'test de rojo a verde', none: 'sin un test que falle' };
const mailTo = (d: Detail, to: string) => (to === 'team' ? 'el equipo' : d.person);

// When a request waiting on the person expires (#404), and its reminder.
function Expiry({ d }: { d: Detail }) {
  const now = useNow();
  const e = d.expiry;
  if (!e) return null;
  const left = Date.parse(e.expiresAt) - now;
  const whenLeft = left > 0 ? `en ${short(left)}` : 'en la próxima vuelta del tick';
  const who = firstName(d.person);
  const reminder = e.remindedAt ? ` Le llegó un recordatorio ${ago(e.remindedAt, now)}.` : e.remindAt ? ` Si no responde, le llega un recordatorio el ${when(e.remindAt)}.` : '';
  return <div className="d pd-exp">{d.status === 'answered'
    ? `Se cierra solo el ${when(e.expiresAt)} (${whenLeft}) si ${who} no escribe.`
    : `Vence el ${when(e.expiresAt)} (${whenLeft}): sin respuesta, se cancela solo.${reminder}`}</div>;
}

// What it waits on now, and who has to do it.
function Now({ d }: { d: Detail }) {
  const shell = useShell();
  const actions = useActions();
  const who = firstName(d.person);
  const running = d.runs.find((run) => run.state === 'running');
  const lastEvent = d.activity.entries.flatMap((e) => (e.type === 'event' ? [e.event] : [])).at(-1);
  // Every card ends with when it expires and Cerrar pedido, where they apply (#404).
  const card = (cls: string, k: ReactNode, t: string, body: ReactNode = null, acts: ReactNode = null) => (
    <div className={`pd-now ${cls}`}><div className="k">{k}</div><div className="t">{t}</div>{body}<Expiry d={d} />{acts && <div className="acts">{acts}</div>}<TeamClose d={d} /></div>
  );
  const open = (number: number, label: string) => <button className="btn-s" onClick={() => shell.openItem(`${d.repo}#${number}`)}>{label}</button>;
  const desc = (text: string) => <div className="d">{text}</div>;
  if (running) {
    return card('running', <><Dot cls="live" /> Ahora · ronin trabajando</>, `${runTitle(running)}${running.issueNumber ? ` en #${running.issueNumber}` : running.prNumber ? ` en el PR #${running.prNumber}` : ''}`,
      <div className="feed">{running.lastStep ? `▸ ${running.lastStep}` : 'Arrancando…'}</div>, <button className="btn-s" onClick={() => actions.run(running.runId)}>Ver la corrida</button>);
  }
  if (d.waitsOn === 'ronin' && lastEvent?.kind === 'failed') {
    return card('failed', 'Ahora · falló lo último que hizo ronin', 'El tick lanza otro worker en su próxima vuelta', <div className="err">{lastEvent.error}</div>);
  }
  const k = <>{ICON.wait} Ahora</>;
  // Who chose to deploy it (#353), when ronin could approve its PR as them.
  const approvedAs = d.activity.entries.some((e) => e.type === 'event' && e.event.kind === 'pr-approved' && e.event.ok && e.event.number === d.pr);
  const deployed = d.devDecision?.kind === 'deploy' && approvedAs ? d.devDecision.by : null;
  switch (d.status) {
    case 'thinking': return card('running', k, 'ronin va a leerlo', desc('Espera un lugar para el agente.'));
    case 'minor': return card('running', k, lastEvent?.kind === 'waiting' ? 'El prototipo espera turno: hay otro en curso en este repo' : 'ronin va a armar el prototipo');
    case 'reproducing': return card('running', k, lastEvent?.kind === 'waiting' ? 'La reproducción espera turno: hay otra copia de la app en curso en este repo' : 'ronin va a reproducir el error', desc(`Levanta una copia de la app con datos de prueba, sigue los pasos, escribe un test que falle y prueba el arreglo. Intento ${(d.bug?.reproductions.length ?? 0) + 1} de ${REPRODUCTIONS}.`));
    case 'awaiting-dev': return <DevDecide d={d} />;
    case 'fixing':
      if (d.pr && deployed) return card('waiting', k, `El PR #${d.pr} se mergea con el CI en verde`, desc(`${deployed} eligió aprobarlo y desplegarlo, y ronin lo aprobó a su nombre. Al mergear, ${who} recibe “listo”.`), open(d.pr, `Abrir el PR #${d.pr}`));
      if (d.pr) return card('waiting', k, `Espera que un dev apruebe el PR #${d.pr}`, desc(`Es el arreglo del error, partiendo del test y el diff de la reproducción. Tiene ronin:auto-merge: se mergea solo cuando lo aprueben y el CI esté verde. Al mergear, ${who} recibe “listo”.`), open(d.pr, `Abrir el PR #${d.pr}`));
      if (d.issue) return card('running', k, `ronin va a hacer el arreglo en #${d.issue.number}`, desc(`Lo reprodujo con un test que falla y el arreglo de prueba lo pasó a verde. ${who} no tiene que aprobar nada.`), open(d.issue.number, `Abrir #${d.issue.number}`));
      return card('running', k, 'ronin va a abrir el issue del arreglo');
    case 'asking': return card('waiting', k, `Espera a ${who}: ronin le preguntó algo`, desc(`Le escribió ${ago(d.messages.at(-1)?.at)} y le avisó por correo. Lleva ${d.questions} de 3 preguntas.`));
    case 'answered': return card('', k, `ronin le respondió a ${who}`, desc('Puede seguir escribiendo si necesita algo más.'));
    case 'interviewing': return card('waiting', k, `Espera a ${who}: las preguntas de la entrevista`, desc(`Es para el equipo. ronin le dejó preguntas ${ago(d.messages.at(-1)?.at)} para que el issue llegue con las decisiones tomadas, y le avisó por correo. Ronda ${d.interview?.rounds ?? 1} de 2. Si no responde, el pedido puede pasarse al equipo sin las respuestas.`));
    case 'confirming': return card('waiting', k, `Espera a ${who}: confirmar lo que entendió ronin`, desc('Al confirmarlo pasa al equipo, con sus respuestas y el resumen.'));
    case 'proposed': {
      const left = 3 - d.prototypes.length - d.proposals;
      // A proposal in words only (#409): since ronin's last message.
      const shown = d.worded ? d.messages.filter((m) => m.from === 'ronin').at(-1)?.at : d.prototypes.at(-1)?.at;
      return card('waiting', k, d.worded ? `Espera a ${who}: aprobar la propuesta, pedir un ajuste o pasarla al equipo` : `Espera a ${who}: aprobar el prototipo, pedir un ajuste o pasarlo al equipo`, desc(`${d.worded ? 'Se la propuso sin prototipo' : 'Se lo mostró'} ${ago(shown)} y le avisó por correo. ${left > 0 ? `Le ${left === 1 ? 'queda 1 ajuste' : `quedan ${left} ajustes`}.` : 'No le quedan ajustes.'}`));
    }
    case 'approved':
      if (d.pr && deployed) return card('waiting', k, `El PR #${d.pr} se mergea con el CI en verde`, desc(`${deployed} eligió aprobarlo y desplegarlo, y ronin lo aprobó a su nombre. Al mergear, ${who} recibe “listo, sale en la próxima actualización”.`), open(d.pr, `Abrir el PR #${d.pr}`));
      if (d.pr) return card('waiting', k, `Espera que un dev apruebe el PR #${d.pr}`, desc(`Tiene ronin:auto-merge: se mergea solo cuando lo aprueben y el CI esté verde. Al mergear, ${who} recibe “listo, sale en la próxima actualización”.`), open(d.pr, `Abrir el PR #${d.pr}`));
      if (d.issue) return card('running', k, `ronin va a hacer el cambio en #${d.issue.number}`, desc('Lo toma como cualquier issue asignado a ronin y abre el PR.'), open(d.issue.number, `Abrir #${d.issue.number}`));
      return card('running', k, 'ronin va a abrir el issue del cambio');
    case 'big':
      if (d.issue) return card('waiting', k, `Espera al equipo: el issue #${d.issue.number}`, desc(`${who} recibe un correo cuando el issue se cierre. Mientras, ronin no hace nada más con este pedido.`), open(d.issue.number, `Abrir #${d.issue.number}`));
      return card('running', k, 'ronin va a abrir el issue del equipo');
    default: {
      const [, label] = STATUS[d.status] ?? ['', d.status];
      return card('closed', 'Cerrado', label);
    }
  }
}

type Shown = [tone: string, icon: string, title: string, extra: ReactNode, small?: boolean];

// One event of its activity.
function shownEvent(d: Detail, e: RequestEvent): Shown {
  const who = d.person;
  switch (e.kind) {
    case 'worker': return ['', 'wait', e.by === 'tick' ? 'El tick vio el pedido sin worker y lanzó otro' : 'Se lanzó un worker', null, true];
    case 'failed': return ['crit', 'crit', ({ classify: 'Falló al leerlo', prototype: 'Falló un intento de prototipo', reproduce: 'Falló un intento de reproducción', worker: 'El worker falló' } as Record<string, string>)[e.step] ?? 'Falló', <div className="bx err">{e.error}</div>];
    case 'waiting': return ['', 'wait', d.bug ? 'La reproducción esperó turno: había otra copia de la app en curso en el repo' : 'El prototipo esperó turno: había otro en curso en el repo', null, true];
    case 'reproduced': return e.reproduced
      ? ['ok', 'ok', `Lo reprodujo (intento ${e.round})`, <span className="m">{TEST[e.test]}</span>, true]
      : ['warn', 'crit', `No lo pudo reproducir (intento ${e.round})`, <span className="m">{TEST[e.test]}</span>, true];
    case 'classified': return e.verdict === 'minor'
      ? ['ok', 'ok', d.verdict?.kind === 'minor' && d.verdict.prototype === false ? 'Lo clasificó como cambio menor, sin prototipo' : 'Lo clasificó como cambio menor', d.verdict?.kind === 'minor' && d.verdict.proposal ? <div className="bx">{d.verdict.proposal}</div> : null]
      : e.verdict === 'error' ? ['run', 'run', 'Lo leyó como un reporte de error', d.bug?.steps ? <div className="bx">{d.bug.steps}</div> : null]
        : ['warn', 'crit', 'Lo pasó al equipo', d.verdict?.kind === 'big' && d.verdict.reason ? <div className="bx">{d.verdict.reason}</div> : null];
    case 'interview': return ({
      asked: ['', 'ronin', `Ronda ${e.round} de la entrevista`, null, true],
      answered: ['', 'person', `${who} respondió la ronda ${e.round}`, null, true],
      summary: ['', 'ronin', `Resumen para que ${who} lo confirme`, null, true],
      corrected: ['', 'person', `${who} corrigió el resumen`, null, true],
      confirmed: ['ok', 'ok', `${who} confirmó el resumen: pasa al equipo`, null, true],
      skipped: ['warn', 'person', `${who} lo envió al equipo sin terminar la entrevista`, null, true],
    } as Record<string, Shown>)[e.step] ?? ['', 'wait', 'Entrevista', null];
    case 'dev-decided': return e.decision === 'decline'
      ? ['crit', 'crit', `${e.by} decidió no hacerlo`, d.devDecision?.reason ? <div className="bx">{d.devDecision.reason}</div> : null]
      : ['ok', 'ok', `${e.by} lo aprobó ${e.decision === 'deploy' ? 'para desplegar' : 'con revisión'}`, <span className="m">{e.decision === 'deploy' ? 'ronin aprueba el PR a su nombre y lo mergea con el CI en verde' : 'el PR espera la aprobación de un dev'}</span>];
    case 'deploy-skipped': return ['warn', 'crit', `Quedó fuera del despliegue automático: no se aplica sobre ${e.base}`, <span className="m">{e.files.length ? `Choca en ${e.files.join(', ')}.` : ''}{e.needs.length ? ` Necesita ${e.needs.map((n) => `#${n}`).join(', ')}.` : ''} Se intenta otra vez en el próximo lote, o se despliega a mano.</span>];
    case 'team-message': case 'person-reply': return ['', 'mail', '', null, true];
    case 'pr-approved': return e.ok
      ? ['ok', 'ok', `ronin aprobó el PR #${e.number} a nombre de ${e.by}`, null, true]
      : ['warn', 'crit', `No se pudo aprobar el PR #${e.number} a nombre de ${e.by}`, <span className="m">Su sesión de GitHub ya no sirve: el PR espera que un dev lo apruebe.</span>];
    case 'decided': return e.decision === 'approved' ? ['ok', 'ok', `${who} aprobó el prototipo`, null] : ['warn', 'person', `${who} no aprobó el prototipo`, null];
    case 'mail': return [e.ok ? 'mail' : 'crit', 'mail', e.ok ? `Correo a ${mailTo(d, e.to)}` : `No salió el correo a ${mailTo(d, e.to)}`, <span className="m">{e.subject}</span>, e.ok];
    case 'issue': return ['ok', 'ok', e.team ? `Abrió el issue del equipo #${e.number}` : `Abrió el issue #${e.number} para ronin`, null];
    case 'pr': return ['ok', 'ok', `ronin abrió el PR #${e.number}, con ronin:auto-merge`, null];
    case 'pr-closed': return ['warn', 'crit', `El PR #${e.number} se cerró sin merge`, null];
    case 'closed': return e.by ? ['', 'crit', `${e.by} cerró el pedido desde el tablero`, d.closeNote ? <div className="bx">{d.closeNote.text}</div> : null]
      : e.status === 'done' ? ['ok', 'ok', 'Se mergeó: sale en la próxima actualización', null] : e.status === 'resolved' ? ['ok', 'ok', 'El equipo cerró el issue como resuelto', null] : ['', 'crit', 'El equipo decidió no hacerlo por ahora', null];
    case 'cancelled': return ['', 'person', `${who} lo canceló`, null];
    case 'reminded': return ['', 'mail', `Recordatorio a ${who}: el pedido espera su respuesta`, null, true];
    case 'expired': return ['', 'wait', e.answered ? 'Se cerró solo: nadie escribió después de la respuesta' : `Se canceló solo: ${who} no respondió a tiempo`, null];
    case 'deploy': return e.state === 'deployed' ? ['ok', 'ok', `Salió en ${e.tag}${e.prerelease ? ' (pre-release)' : ''}`, null] : e.state === 'failed' ? ['crit', 'crit', `Falló el despliegue de ${e.tag}`, null] : ['run', 'run', `Entró en el release ${e.tag}${e.prerelease ? ' (pre-release)' : ''}`, null];
    default: return ['', 'wait', (e as { kind: string }).kind, null];
  }
}

function Item({ tone, icon, title, extra = null, time, small = false, children }: { tone: string; icon: string; title: string; extra?: ReactNode; time: string; small?: boolean; children?: ReactNode }) {
  return (
    <li className={`pd-ev ${tone} ${small ? 'small' : ''}`}><span className="ic">{ICON[icon] ?? ICON.wait}</span><div className="h"><b>{title}</b>{extra}<span className="tm" title={time ? when(time) : ''}>{time ? hhmm(time) : 'sin hora'}</span></div>{children}</li>
  );
}

const RUN_DID: Record<string, string> = { 'portal-prototype': 'Armó el prototipo', 'portal-reproduce': 'Intentó reproducirlo', 'portal-request': 'ronin lo leyó', 'portal-interview': 'ronin leyó sus respuestas' };

function EntryView({ d, e }: { d: Detail; e: Entry }) {
  const actions = useActions();
  if (e.type === 'run') return <Item tone="run" icon="run" title={RUN_DID[e.run.taskType] ?? typeName(e.run.taskType)} time={e.at}><RunCard run={e.run} onOpen={actions.run} /></Item>;
  if (e.type === 'message') {
    const m = e.message;
    const long = m.text.length > 320;
    const tried = d.bug?.reproductions.find((t) => t.messageId === m.id);
    const title = m.from === 'team' ? `${m.by ?? 'El equipo'} le escribió a ${firstName(d.person)}` : m.to === 'team' ? `${d.person} le respondió al equipo` : m.answers ? `${d.person} respondió las preguntas` : m.confirmed ? `${d.person} confirmó el resumen` : m.skipped ? `${d.person} lo envió sin responder`
      : m.questions ? 'Le dejó preguntas' : m.understood ? 'Le mostró lo que entendió'
        : m.from === 'person' ? (e.first ? `${d.person} abrió el pedido` : `${d.person} escribió`) : e.prototype ? `Le mostró el prototipo ${e.prototype}` : tried ? `Le contó lo que encontró (intento ${tried.round})` : 'ronin le respondió';
    const side = m.from === 'person' ? 'person' : 'ronin';
    return (
      <Item tone={m.from === 'team' ? 'team' : side} icon={m.from === 'team' ? 'person' : side} title={title} extra={e.first ? <span className="m">{d.appName}</span> : null} time={e.at}>
        {m.text && <div className={`bx ${m.from === 'ronin' ? 'r' : 'q'}`}>{long ? `${m.text.slice(0, 300)}…` : m.text}{long && <> <button className="more" onClick={() => actions.tab('chat')}>Ver completo</button></>}</div>}
        <Interview m={m} />
        <Thumbs d={d} m={m} />
        {e.prototype && d.prototypes.find((p) => p.round === e.prototype)?.patch ? <button className="more" onClick={() => actions.tab('team')}>Ver el borrador para el equipo →</button>
          : tried ? <button className="more" onClick={() => actions.tab('repro')}>Ver la reproducción →</button> : null}
      </Item>
    );
  }
  // The team's messages and the person's answers are their messages, above.
  if (e.event.kind === 'team-message' || e.event.kind === 'person-reply') return null;
  const [tone, icon, title, extra, small] = shownEvent(d, e.event);
  return <Item tone={tone} icon={icon} title={title} extra={small ? extra : null} time={e.at} small={small}>{small ? null : extra}</Item>;
}

export function Activity({ d }: { d: Detail }) {
  const { entries, untimed } = d.activity;
  return (
    <>
      <Now d={d} />
      <ol className="pd-tl">{entries.map((e, i) => <EntryView key={i} d={d} e={e} />)}{untimed.map((ev, i) => <EntryView key={`u${i}`} d={d} e={{ type: 'event', at: '', event: ev }} />)}</ol>
    </>
  );
}
