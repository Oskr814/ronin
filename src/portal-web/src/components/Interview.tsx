import { Fragment } from 'react';
import type { Detail, Message, Question, Understood } from '../api.js';

// The interview (#225): a big request, with questions in a form before it
// goes to the team. ronin's last message has them; the person's answers go
// back as option indexes, and the server writes them in words.

export const UNSURE = 'No sé, que lo decida el equipo';

export interface Answer {
  picked?: string | string[];
  text?: string;
  other?: string;
  unsure?: boolean;
}
export type Answers = Record<string, Answer>;

export const openQuestions = (d: Detail): Question[] =>
  (d.status === 'interviewing' ? d.messages.filter((m) => m.from === 'ronin').at(-1)?.questions ?? [] : []);

const pickedOf = (q: Question, a: Answer): string[] =>
  (q.kind === 'many' ? (a.picked as string[] | undefined) ?? [] : a.picked === undefined ? [] : [a.picked as string]);

export function answered(q: Question, a: Answer | undefined): boolean {
  if (!a) return false;
  if (a.unsure) return true;
  if (q.kind === 'text') return Boolean(a.text?.trim());
  const picked = pickedOf(q, a);
  return picked.length > 0 && (!picked.includes('otra') || Boolean(a.other?.trim()));
}

// The required ones answered, of how many.
export function progress(qs: Question[], answers: Answers): [number, number] {
  const required = qs.filter((q) => !q.optional);
  return [required.filter((q) => answered(q, answers[q.id])).length, required.length];
}

export function missing(qs: Question[], answers: Answers): Question | undefined {
  return qs.find((q) => !q.optional && !answered(q, answers[q.id]));
}

export function payload(qs: Question[], answers: Answers) {
  return qs.filter((q) => answers[q.id]).map((q) => {
    const a = answers[q.id];
    if (a.unsure) return { id: q.id, unsure: true };
    if (q.kind === 'text') return { id: q.id, text: a.text ?? '' };
    const picked = pickedOf(q, a);
    return { id: q.id, choices: picked.filter((v) => v !== 'otra').map(Number), ...(picked.includes('otra') ? { other: a.other ?? '' } : {}) };
  });
}

function QuestionSet({ q, i, answer, onChange }: { q: Question; i: number; answer: Answer; onChange: (a: Answer) => void }) {
  const multi = q.kind === 'many';
  const picked = pickedOf(q, answer);
  const pick = (value: string, on: boolean) => {
    if (!multi) return onChange({ ...answer, picked: value });
    onChange({ ...answer, picked: on ? [...picked.filter((v) => v !== value), value] : picked.filter((v) => v !== value) });
  };
  const type = multi ? 'checkbox' : 'radio';
  const done = answered(q, answer);
  return (
    <fieldset className={`iv-q ${done ? 'done' : ''} ${answer.unsure ? 'is-unsure' : ''}`}>
      <legend><span className="n" aria-hidden="true">{done ? '✓' : i + 1}</span><span>{q.text}{q.optional && <> <small>(opcional)</small></>}</span></legend>
      {q.help && <p className="why">{q.help}</p>}
      {q.kind === 'text'
        ? <textarea className="iv-text" rows={2} maxLength={1000} placeholder={q.example ?? ''} aria-label={q.text} value={answer.text ?? ''} onChange={(e) => onChange({ ...answer, text: e.target.value })} />
        : (
          <>
            <div className="opts">
              {(q.options ?? []).map((o, j) => (
                <label key={j} className="opt"><input type={type} name={`q-${q.id}`} value={j} checked={picked.includes(String(j))} onChange={(e) => pick(String(j), e.target.checked)} /><span>{o}</span></label>
              ))}
              {q.other && (
                <label className="opt other">
                  <input type={type} name={`q-${q.id}`} value="otra" checked={picked.includes('otra')} onChange={(e) => pick('otra', e.target.checked)} />
                  <span>Otra:</span>
                  {/* Writing the other answer picks it. */}
                  <input type="text" className="other-t" maxLength={300} value={answer.other ?? ''} placeholder="escríbela" aria-label="Otra respuesta" onChange={(e) => {
                    const other = e.target.value;
                    const next = { ...answer, other };
                    if (other.trim() && !picked.includes('otra')) next.picked = multi ? [...picked, 'otra'] : 'otra';
                    onChange(next);
                  }} />
                </label>
              )}
            </div>
            <label className="unsure"><input type="checkbox" checked={Boolean(answer.unsure)} onChange={(e) => onChange({ ...answer, unsure: e.target.checked })} />{UNSURE}</label>
          </>
        )}
    </fieldset>
  );
}

// The questions on screen, inside the conversation.
export function InterviewForm({ d, answers, onAnswer }: { d: Detail; answers: Answers; onAnswer: (id: string, a: Answer) => void }) {
  const qs = openQuestions(d);
  const { round, rounds } = d.interview;
  return (
    <form className="iv" onSubmit={(e) => e.preventDefault()}>
      <div className="iv-h"><b>{round > 1 ? 'Unas preguntas más' : 'Preguntas para el equipo'}</b><span>{qs.length} {qs.length === 1 ? 'pregunta' : 'preguntas'} · ronda {round} de {rounds}</span></div>
      {qs.map((q, i) => <QuestionSet key={q.id} q={q} i={i} answer={answers[q.id] ?? {}} onChange={(a) => onAnswer(q.id, a)} />)}
    </form>
  );
}

// The answers the person gave, in their message.
export function AnswersView({ m }: { m: Message }) {
  return (
    <>
      <dl className="qa">{m.answers!.map((a, i) => <div key={i}><dt>{a.question}</dt><dd className={a.unsure ? 'unsure-a' : ''}>{a.answer}</dd></div>)}</dl>
      {m.text && <div className="qa-note"><b>Algo más:</b> <Paragraphs text={m.text} /></div>}
    </>
  );
}

// What ronin understood after the interview: the person confirms it, or
// corrects it while there are corrections left.
export function UnderstoodView({ u }: { u: Understood }) {
  return (
    <div className="spec">
      <dl>{u.decisions.map((d, i) => <div key={i}><dt>{d.topic}</dt><dd>{d.decision}</dd></div>)}</dl>
      {u.team.length > 0 && <div className="spec-x"><b>Lo decide el equipo</b>{u.team.map((t, i) => <span key={i}>{t}</span>)}</div>}
      {u.out.length > 0 && <div className="spec-x"><b>Queda fuera</b>{u.out.map((t, i) => <span key={i}>{t}</span>)}</div>}
    </div>
  );
}

// Paragraphs at blank lines, line breaks inside them.
export function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i}>{p.split('\n').map((line, j) => <Fragment key={j}>{j > 0 && <br />}{line}</Fragment>)}</p>
      ))}
    </>
  );
}
