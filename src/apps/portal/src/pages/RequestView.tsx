import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { client, ended, ok, type Detail, type Me } from '../api.js';
import { MenuButton } from '../components/MenuButton.js';
import { useBusy } from '../lib/busy.js';
import { Composer, ComposerFrame, useDraft } from '../components/Composer.js';
import { AnswersView, InterviewForm, missing, openQuestions, Paragraphs, payload, progress, UnderstoodView, type Answers } from '../components/Interview.js';
import { Chip } from '../components/Chip.js';
import { CLOSED, hhmm, initials, left, WORKING } from '../lib/text.js';

const POLL_MS = 2000;

// One request: its conversation and, under it, what the person can do now —
// answer, answer the interview, confirm the summary, decide on the
// prototype, cancel — or why there's nothing to do.
export function RequestView({ n, me, onMenu, onZoom, onMissing }: {
  n: number;
  me: Me;
  onMenu: () => void;
  onZoom: (src: string) => void;
  onMissing: (why: string) => void;
}) {
  const queryClient = useQueryClient();
  const params = { param: { n: String(n) } };
  // While ronin reads it or draws its prototype, it's asked again every few
  // seconds, and right away when the person comes back to the tab.
  const query = useQuery({
    queryKey: ['request', n],
    queryFn: () => ok(client.requests[':n'].$get(params)),
    refetchInterval: (q) => (q.state.data && WORKING[q.state.data.status] ? POLL_MS : false),
    refetchOnWindowFocus: (q) => Boolean(q.state.data && WORKING[q.state.data.status]),
  });
  const d = query.data;

  // A request that isn't there (or not the person's): back to a new one, saying why.
  useEffect(() => {
    if (query.error && !ended(query.error)) onMissing(query.error.message);
  }, [query.error, onMissing]);

  // The list follows the request's status and its messages.
  const shape = d ? `${d.status}:${d.messages.length}` : '';
  const seen = useRef(shape);
  useEffect(() => {
    if (!shape || seen.current === shape) return;
    seen.current = shape;
    void queryClient.invalidateQueries({ queryKey: ['requests'] });
  }, [shape, queryClient]);

  const draft = useDraft();
  const [answers, setAnswers] = useState<Answers>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<'aprobar' | 'rechazar' | null>(null);
  const [note, setNote] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  useBusy(sending || Object.keys(answers).length > 0);

  // Each change: the request as it is after it, and the list too.
  const act = async (change: () => Promise<Detail | null>, after: () => void = () => {}) => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const next = await change();
      if (next) {
        queryClient.setQueryData(['request', n], next);
        await queryClient.invalidateQueries({ queryKey: ['requests'] });
        after();
      }
    } catch (e) {
      if (!ended(e)) setError((e as Error).message);
    }
    setSending(false);
  };

  const send = () => {
    if (!d) return;
    const text = draft.text.trim();
    if (d.status === 'interviewing') {
      const qs = openQuestions(d);
      const lacking = missing(qs, answers);
      if (lacking) {
        setError(`Te falta responder: «${lacking.text}». Si no sabes, marca «No sé».`);
        return;
      }
      return act(() => ok(client.requests[':n'].interview.$post({ ...params, json: { answers: payload(qs, answers), note: text, images: draft.pending } })), () => {
        draft.clear();
        setAnswers({});
      });
    }
    if (!text && !draft.pending.length) return;
    if (d.status === 'confirming' && correcting) {
      return act(() => ok(client.requests[':n'].understood.$post({ ...params, json: { ok: false, text, images: draft.pending } })), () => {
        draft.clear();
        setCorrecting(false);
      });
    }
    return act(() => ok(client.requests[':n'].messages.$post({ ...params, json: { text, images: draft.pending } })), draft.clear);
  };

  // The thread stays at the bottom while the person is there; a new round of
  // questions opens at ronin's message instead.
  const thread = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const shownRound = useRef<string | null>(null);
  const round = d?.status === 'interviewing' && !skipping ? `${n}:${d.interview.round}` : null;
  useLayoutEffect(() => {
    const el = thread.current;
    if (!el || !d) return;
    if (round && shownRound.current !== round) {
      shownRound.current = round;
      const msgs = el.querySelectorAll<HTMLElement>('.msg');
      const last = msgs[msgs.length - 1];
      if (last) el.scrollTop = last.offsetTop - el.offsetTop - 16;
    } else if (!round && atBottom.current) el.scrollTop = el.scrollHeight;
  });
  const imageLoaded = () => {
    if (!round && atBottom.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  };
  // A message that arrives while the person reads further up: a notice that
  // takes them down, instead of moving what they read (#372). ronin's, said
  // to a screen reader too.
  const count = d?.messages.length ?? 0;
  const counted = useRef(count);
  const [below, setBelow] = useState(false);
  const [said, setSaid] = useState('');
  useEffect(() => {
    const before = counted.current;
    counted.current = count;
    if (!d || !before || count <= before) return;
    if (!atBottom.current) setBelow(true);
    const last = d.messages.at(-1);
    if (last?.from === 'ronin') setSaid(`ronin te escribió: ${last.text ?? 'una respuesta nueva'}`);
  }, [count, d]);
  const toBottom = () => {
    const el = thread.current;
    setBelow(false);
    el?.scrollTo({ top: el.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  if (!d) return <><div className="top"><MenuButton onClick={onMenu} /><h2>Cargando…</h2></div><div className="content" /></>;

  const composer = (props: { placeholder: string; label: string; note?: string; above?: ReactNode; focus?: boolean }) => (
    <Composer draft={draft} sending={sending} error={error} onSend={() => void send()} onError={setError} {...props} />
  );

  let foot: ReactNode;
  if (cancelling) {
    foot = (
      <Confirm title="¿Cancelar este pedido?" error={error} sending={sending} busyLabel="Cancelando…" label="Sí, cancelar"
        onBack={() => { setCancelling(false); setError(null); }}
        onGo={() => act(() => ok(client.requests[':n'].cancel.$post(params)), () => setCancelling(false))}>
        <p>{d.status === 'big' || d.status === 'awaiting-dev' ? 'El equipo de desarrollo deja de tenerlo pendiente.' : 'ronin deja de trabajar en él.'} No se puede deshacer, pero puedes enviar uno nuevo cuando quieras.</p>
      </Confirm>
    );
  } else if (d.status === 'proposed') {
    foot = deciding ? (
      <Confirm title={deciding === 'aprobar' ? '¿Apruebas este prototipo?' : '¿Se lo pasamos al equipo?'} error={error} sending={sending} busyLabel="Enviando…"
        label={deciding === 'aprobar' ? 'Sí, aprobar' : 'Pasar al equipo'}
        onBack={() => { setDeciding(null); setError(null); }}
        onGo={() => act(() => ok(client.requests[':n'].decision.$post({ ...params, json: { decision: deciding, text: note.trim() } })), () => setDeciding(null))}>
        <p>{deciding === 'aprobar' ? 'El equipo de desarrollo hará el cambio tal como lo ves.' : 'El equipo de desarrollo verá tu pedido, lo que conversamos y el prototipo.'}</p>
        {deciding === 'rechazar' && <textarea id="note" rows={2} maxLength={4000} placeholder="¿Qué no te convenció? (opcional)" autoFocus value={note} onChange={(e) => setNote(e.target.value)} />}
      </Confirm>
    ) : (
      <Decision d={d} composer={composer} onDecide={(how) => { setDeciding(how); setError(null); }} />
    );
  } else if (d.status === 'interviewing') {
    if (skipping) {
      foot = (
        <Confirm title="¿Enviarlo al equipo sin responder?" error={error} sending={sending} busyLabel="Enviando…" label="Enviar sin responder" backLabel="Volver a las preguntas"
          onBack={() => { setSkipping(false); setError(null); }}
          onGo={() => act(() => ok(client.requests[':n'].skip.$post(params)), () => { setSkipping(false); setAnswers({}); })}>
          <p>El equipo verá tu pedido tal como lo escribiste. Si les falta algo, te lo preguntan después y puede tardar más.</p>
        </Confirm>
      );
    } else {
      const [done, total] = progress(openQuestions(d), answers);
      foot = composer({
        placeholder: '¿Algo más que el equipo deba saber? (opcional)',
        label: 'Enviar respuestas',
        note: 'Si no sabes alguna, marca «No sé»: lo decide el equipo',
        above: (
          <div className="iv-f">
            <span className="prog"><b>{done}</b> de {total} respondidas<i className="bar" aria-hidden="true"><i style={{ width: `${total ? (100 * done) / total : 100}%` }} /></i></span>
            <button className="btn ghost" onClick={() => { setSkipping(true); setError(null); }}>Enviar sin responder</button>
          </div>
        ),
      });
    }
  } else if (d.status === 'confirming') {
    foot = correcting
      ? composer({
        placeholder: '¿Qué entendí mal o qué falta?',
        label: 'Enviar corrección',
        note: 'ronin corrige el resumen y te lo muestra de nuevo',
        focus: true,
        above: <div className="iv-f"><span className="prog">Corregir el resumen</span><button className="btn ghost" onClick={() => { setCorrecting(false); setError(null); }}>Volver</button></div>,
      })
      : (
        <ComposerFrame error={error}>
          <div className="decide">
            <span>¿Lo entendí bien?</span>
            {d.interview.correctionsLeft > 0 && <button className="btn" onClick={() => { setCorrecting(true); setError(null); }}>Corregir algo</button>}
            <button className="btn primary" disabled={sending} onClick={() => act(() => ok(client.requests[':n'].understood.$post({ ...params, json: { ok: true } })))}>{sending ? 'Enviando…' : 'Sí, enviarlo al equipo'}</button>
          </div>
          {d.interview.correctionsLeft === 0 && <p className="hint">No quedan correcciones: lo que falte, el equipo lo ve contigo.</p>}
        </ComposerFrame>
      );
  } else if (d.status === 'asking' || d.status === 'answered') {
    foot = composer({ placeholder: d.status === 'asking' ? 'Responde a ronin…' : 'Escríbele a ronin si necesitas algo más…', label: 'Enviar' });
  } else {
    foot = <div className="closed-bar">{CLOSED[d.status] ?? ''}</div>;
  }

  return (
    <>
      <div className="top">
        <MenuButton onClick={onMenu} /><h2>{d.title}</h2><span className="proj-l">{d.appName} · P-{d.number}</span><Chip status={d.status} />
        {d.cancellable && !cancelling && <button className="btn cancel-btn" onClick={() => { setCancelling(true); setDeciding(null); setError(null); }}>Cancelar<span className="wide"> pedido</span></button>}
      </div>
      <div className="content" id="thread" ref={thread} onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (atBottom.current && below) setBelow(false);
      }}>
        <div className="content-in thread">
          <Thread d={d} me={me} onZoom={onZoom} onImage={imageLoaded} />
          {d.status === 'interviewing' && !skipping && <InterviewForm d={d} answers={answers} onAnswer={(id, a) => { setError(null); setAnswers({ ...answers, [id]: a }); }} />}
          <Working d={d} />
        </div>
      </div>
      {below && <div className="newmsg-w"><button className="newmsg" onClick={toBottom}>Mensaje nuevo ↓</button></div>}
      <div className="sr" aria-live="polite">{said}</div>
      {foot}
    </>
  );
}

function Thread({ d, me, onZoom, onImage }: { d: Detail; me: Me; onZoom: (src: string) => void; onImage: () => void }) {
  return (
    <>
      <div className="sys">{d.appName} · {hhmm(d.createdAt)}</div>
      {d.messages.map((m) => {
        const ronin = m.from === 'ronin';
        // A prototype's images come with their captions ("Antes: …", "Después: …").
        const images = !m.images.length ? null
          : m.captions ? (
            <div className="shots">{m.images.map((src, i) => (
              <figure key={src} className="shot"><button className="att" onClick={() => onZoom(src)}><img src={src} alt={m.captions![i] ?? `Imagen ${i + 1}`} onLoad={onImage} /></button><figcaption>{m.captions![i] ?? ''}</figcaption></figure>
            ))}</div>
          ) : (
            <div className="atts">{m.images.map((src, i) => (
              <button key={src} className="att" onClick={() => onZoom(src)}><img src={src} alt={`Imagen ${i + 1}`} loading="lazy" onLoad={onImage} /></button>
            ))}</div>
          );
        return (
          <div key={m.id} className={`msg ${ronin ? '' : 'mine'}`}>
            {ronin ? <div className="seal" aria-hidden="true">浪人</div> : <div className="av" aria-hidden="true">{initials(me.name)}</div>}
            <div className="body">
              <div className="who"><b>{ronin ? 'ronin' : me.name}</b> {hhmm(m.at)}</div>
              <div className="bubble">
                {m.answers ? <AnswersView m={m} />
                  : m.skipped ? <p className="ack">Lo envié sin responder las preguntas.</p>
                    : m.confirmed ? <p className="ack">✓ Está bien, envíalo al equipo.</p>
                      : m.text ? <Paragraphs text={m.text} /> : null}
                {m.understood && <UnderstoodView u={m.understood} />}
                {images}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

// What ronin is doing now, while it works. Reading the interview's answers
// takes seconds, not minutes (#225).
function Working({ d }: { d: Detail }) {
  const last = d.messages.at(-1);
  const working = d.status === 'thinking' && last?.from === 'person' && (last.answers || last.correction)
    ? ['ronin está leyendo tus respuestas…', 'Suele tardar unos segundos.'] : WORKING[d.status];
  if (!working) return null;
  return <div className="working"><div className="spin" aria-hidden="true" /><div>{working[0]}<small>{working[1]}</small></div></div>;
}

// Under a prototype: approve it, turn it down (with an optional note), or
// write an adjustment while there are some left.
function Decision({ d, composer, onDecide }: {
  d: Detail;
  composer: (props: { placeholder: string; label: string; note?: string; above?: ReactNode }) => ReactNode;
  onDecide: (how: 'aprobar' | 'rechazar') => void;
}) {
  const bar = <div className="decide"><span>¿Qué te parece el prototipo?</span><button className="btn" onClick={() => onDecide('rechazar')}>No me sirve</button><button className="btn primary" onClick={() => onDecide('aprobar')}>Aprobar</button></div>;
  if (d.adjustmentsLeft === 0) return <ComposerFrame>{bar}<p className="hint">No quedan ajustes para este pedido.</p></ComposerFrame>;
  return composer({ placeholder: '¿Qué le cambiarías? Escríbelo para otro prototipo…', label: 'Pedir ajuste', note: `${left(d.adjustmentsLeft, 'ajuste', 'ajustes')} · puedes adjuntar capturas`, above: bar });
}

// A question before something that can't be undone.
function Confirm({ title, children, error, sending, label, busyLabel, backLabel = 'Volver', onBack, onGo }: {
  title: string;
  children: ReactNode;
  error: string | null;
  sending: boolean;
  label: string;
  busyLabel: string;
  backLabel?: string;
  onBack: () => void;
  onGo: () => void;
}) {
  return (
    <ComposerFrame error={error}>
      <div className="confirm">
        <b>{title}</b>
        {children}
        <div className="confirm-f"><button className="btn" disabled={sending} onClick={onBack}>{backLabel}</button><button className="btn primary" disabled={sending} onClick={onGo}>{sending ? busyLabel : label}</button></div>
      </div>
    </ComposerFrame>
  );
}

