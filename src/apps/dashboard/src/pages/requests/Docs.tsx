import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { useShell } from '@apps/dashboard/src/shell/hooks.js';
import { when } from '@apps/dashboard/src/lib/format.js';
import { useViewState } from '@apps/dashboard/src/lib/view-state.js';
import { firstName, imagePath, REPRODUCTIONS, type Detail, type Message, type Reproduction } from './model.js';
import { TeamWrite } from './TeamWrite.js';

// What a request's tabs do on the page around them: show another tab, open
// a run in Corridas, or an image in the lightbox.
export interface Actions {
  tab(tab: string): void;
  run(runId: string): void;
  zoom(file: string): void;
}
export const ActionsContext = createContext<Actions>({ tab() {}, run() {}, zoom() {} });
export const useActions = () => useContext(ActionsContext);

export function Thumbs({ d, m }: { d: Detail; m: Message }) {
  const actions = useActions();
  if (!m.images.length) return null;
  return (
    <div className="pd-thumbs">{m.images.map((file, i) => (
      <figure key={file}><button onClick={() => actions.zoom(file)}><img src={imagePath(d.number, file)} alt={m.captions?.[i] ?? 'Imagen'} loading="lazy" /></button>{m.captions?.[i] && <figcaption>{m.captions[i].split(':')[0]}</figcaption>}</figure>
    ))}</div>
  );
}

// The interview of a big request (#225), in a message: the questions ronin
// left, the person's answers, ronin's summary, or how the person sent it on.
const KIND: Record<string, string> = { one: 'una opción', many: 'varias', text: 'texto' };
function QA({ rows }: { rows: Array<[string, string, string?]> }) {
  return <dl className="pd-qa">{rows.map(([k, v, cls], i) => <div key={i}><dt>{k}</dt><dd className={cls ?? ''}>{v}</dd></div>)}</dl>;
}
export function Interview({ m }: { m: Message }) {
  if (m.questions) {
    return (
      <ol className="pd-qs">{m.questions.map((q) => (
        <li key={q.id}>{q.text} <span className="m">{KIND[q.kind] ?? ''}{q.optional ? ', opcional' : ''}</span>{q.options && <span className="o">{q.options.join(' · ')}{q.other ? ' · Otra' : ''}</span>}</li>
      ))}</ol>
    );
  }
  if (m.answers) return <QA rows={m.answers.map((a) => [a.question, a.answer, a.unsure ? 'unsure' : ''])} />;
  if (m.understood) {
    const u = m.understood;
    return <QA rows={[...u.decisions.map((x): [string, string] => [x.topic, x.decision]), ...(u.team.length ? [['Lo decide el equipo', u.team.join(' · '), 'unsure'] as [string, string, string]] : []), ...(u.out.length ? [['Queda fuera', u.out.join(' · ')] as [string, string]] : [])]} />;
  }
  if (m.confirmed) return <p className="m">Confirmó el resumen.</p>;
  if (m.skipped) return <p className="m">Lo envió al equipo sin responder.</p>;
  return null;
}

// Who wrote it: the person (to ronin, or to the team), ronin, or someone of
// the team (#353), whom the person sees as «Equipo de desarrollo».
const author = (d: Detail, m: Message) => (m.from === 'team' ? `${m.by ?? 'El equipo'}, del equipo` : m.from === 'ronin' ? 'ronin' : m.to === 'team' ? `${d.person}, al equipo` : d.person);

export function Chat({ d }: { d: Detail }) {
  return (
    <>
      <p className="m pd-note">Lo mismo que ve {firstName(d.person)} en el portal{d.messages.some((m) => m.from === 'team') ? ', donde los mensajes del equipo van firmados «Equipo de desarrollo»' : ''}.</p>
      <div className="pd-chat">{d.messages.map((m) => <div key={m.id} className={`msg ${m.from}`}><div className="w">{author(d, m)} · {when(m.at)}</div>{m.text}<Interview m={m} /><Thumbs d={d} m={m} /></div>)}</div>
      <TeamWrite d={d} />
    </>
  );
}

export function Diff({ patch }: { patch: string }) {
  return <pre className="diff">{patch.split('\n').map((l, i) => <span key={i} className={l.startsWith('diff --git') ? 'f' : l.startsWith('@@') ? 'h' : /^\+(?!\+\+)/.test(l) ? 'a' : /^-(?!--)/.test(l) ? 'd' : ''}>{l || ' '}</span>)}</pre>;
}
export function diffStat(patch: string): string {
  const lines = patch.split('\n');
  const files = lines.filter((l) => l.startsWith('diff --git')).length;
  return `+${lines.filter((l) => /^\+(?!\+\+)/.test(l)).length} −${lines.filter((l) => /^-(?!--)/.test(l)).length}${files ? ` · ${files} ${files === 1 ? 'archivo' : 'archivos'}` : ''}`;
}

// A prototype's diff, or a reproduction's (#137): read when asked, and kept.
export function Patch({ n, of, round }: { n: number; of: 'prototype' | 'reproduction'; round: number }) {
  const shell = useShell();
  const [asked, setAsked] = useViewState(`request.patch:${n}:${of}:${round}`, false);
  const query = useQuery({
    queryKey: ['request-patch', n, of, round],
    queryFn: () => ok(client.api.requests[':n'][':of{prototype|reproduction}'][':round'].$get({ param: { n: String(n), of, round: String(round) } })).then((r) => r.patch),
    enabled: asked,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) shell.unauthorized(query.error.message);
  }, [query.error, shell]);
  if (query.data !== undefined) return <><div className="m">{diffStat(query.data)}</div><Diff patch={query.data} /></>;
  const ask = () => (asked ? void query.refetch() : setAsked(true));
  return <button className="btn-s" onClick={ask}>{query.isFetching ? 'Cargando…' : query.error ? 'No se pudo leer: reintentar' : 'Ver el diff'}</button>;
}

const Block = ({ title, text }: { title: string; text?: string | null }) => (text ? <><h4>{title}</h4><p>{text}</p></> : null);

export function Team({ d }: { d: Detail }) {
  const v = d.verdict;
  if (!v) return <p className="note">ronin todavía no lo clasificó.</p>;
  // What the person decided in the interview (#225): the last summary, or their answers.
  const summary = d.messages.filter((m) => m.understood).at(-1);
  const answers = d.messages.filter((m) => m.answers);
  return (
    <div className="pd-doc">
      {v.kind === 'big' ? <Block title="Por qué es para el equipo" text={v.reason} /> : <Block title="Qué cambia, en palabras de la persona" text={v.proposal} />}
      {summary ? <><h4>Lo que definió {firstName(d.person)}{d.interview?.confirmed ? '' : ' (sin confirmar)'}</h4><Interview m={summary} /></>
        : answers.length ? <><h4>Lo que respondió {firstName(d.person)}</h4>{answers.map((m) => <Interview key={m.id} m={m} />)}</> : null}
      <Block title="Cómo reproducirlo, según ronin" text={d.bug?.steps} />
      <Block title="Resumen técnico" text={v.summary} />
      <Block title="Lo que se le pidió al prototipo" text={v.instruction} />
      {d.prototypes.map((p) => [
        <h4 key={`h${p.round}`}>Prototipo {p.round} · {when(p.at)}</h4>,
        <p key={`p${p.round}`}>{p.summary}</p>,
        p.patch ? <Patch key={`d${p.round}`} n={d.number} of="prototype" round={p.round} /> : <p key={`d${p.round}`} className="m">Sin diff: el después es una maqueta.</p>,
      ])}
    </div>
  );
}

// Where a try left it: ronin fixes it, the person answers, or the team.
function goes(d: Detail, t: Reproduction, last: boolean): [string, string, string] {
  if (!last) return ['', 'Siguiente intento', `${d.bug!.reproductions.length} de ${REPRODUCTIONS}`];
  if (d.status === 'awaiting-dev') return ['warn', 'Equipo', 'decide si ronin hace el arreglo'];
  if (['fixing', 'done'].includes(d.status) && t.fix === 'small') return ['ok', 'ronin', 'hace el arreglo; un dev aprueba el PR'];
  if (d.status === 'asking' || d.status === 'thinking' || d.status === 'reproducing') return ['warn', `${firstName(d.person)}`, 'le preguntó lo que necesita'];
  if (d.status === 'cancelled') return ['', 'Nadie', 'cancelado'];
  return ['', 'Equipo', d.issue ? `issue #${d.issue.number}` : 'va a abrir el issue'];
}

function Out({ label, text, cls }: { label: string; text?: string; cls: string }) {
  return text ? <div className="pd-out"><div className="lab"><span className={`chip ${cls}`}>{label}</span></div><pre>{text}</pre></div> : null;
}

// A reported error's tries (#137), newest first: what ronin did, its test
// red and green, its images and its diff.
export function Repro({ d }: { d: Detail }) {
  const tries = d.bug?.reproductions ?? [];
  if (!tries.length) {
    return <div className="pd-doc">{d.bug?.steps && <><h4>Cómo reproducirlo, según ronin</h4><p>{d.bug.steps}</p></>}<p className="note">{d.status === 'reproducing' ? 'ronin todavía no termina el primer intento.' : 'Todavía no hay intentos.'}</p></div>;
  }
  return <>{tries.slice().reverse().map((t, i) => {
    const test = t.test;
    const [goTone, goWho, goWhat] = goes(d, t, i === 0);
    const shown = d.messages.find((m) => m.id === t.messageId);
    return (
      <section key={t.round} className="pd-repro">
        <h4>Intento {t.round} · {when(t.at)}</h4>
        <div className="pd-vc">
          <div className={t.reproduced ? 'ok' : 'warn'}><span className="k">Reproducción</span><b>{t.reproduced ? '✓ Reproducido' : '✕ No se reprodujo'}</b><span className="m">con datos de prueba</span></div>
          <div className={test?.red ? (test.green ? 'ok' : 'crit') : ''}><span className="k">Test</span><b>{!test ? 'Sin test' : !test.red ? 'Sin test rojo' : test.green ? 'Rojo → verde' : 'Rojo'}</b><span className="m">{test ? (test.kind === 'e2e' ? 'e2e' : 'directo en la capa') : '—'}</span></div>
          <div className={goTone}><span className="k">Ahora</span><b>{goWho}</b><span className="m">{goWhat}</span></div>
        </div>
        <div className="pd-doc">
          {t.steps.length > 0 && <><h4>Lo que hizo ronin</h4><ol>{t.steps.map((s, k) => <li key={k}>{s}</li>)}</ol></>}
          {t.summary && <><h4>{t.reproduced ? 'Causa' : 'Lo que sospecha ronin'}</h4><p>{t.summary}</p></>}
          {t.fix === 'big' && t.reason && <><h4>Por qué el arreglo no es pequeño</h4><p>{t.reason}</p></>}
          {shown && <Thumbs d={d} m={shown} />}
          {test && <>
            <h4>El test</h4><p><code>{test.name}</code>{test.file && <> en <code>{test.file}</code></>}{test.command && <><br /><span className="m">{test.command}</span></>}</p>{!test.red && <p className="m">No falla con datos de prueba: no prueba el error, es lo que se intentó.</p>}
            <div className="pd-tdd"><Out label={test.red ? 'Rojo' : 'Salida'} text={test.redOutput} cls={test.red ? 'crit' : ''} />{test.green && <Out label="Verde" text={test.greenOutput} cls="ok" />}</div>
          </>}
          {t.patch && <><h4>Diff {t.fix === 'small' ? '(el test y el arreglo de prueba)' : '(el test)'}</h4><Patch n={d.number} of="reproduction" round={t.round} /></>}
        </div>
      </section>
    );
  })}</>;
}
