import { useState } from 'react';
import { Md } from '@apps/dashboard/src/lib/markdown.js';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { type ItemDetail, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { itemParam, oneOr, type ItemPage } from './model.js';

// The questions ronin's internal review (#194) left in the description of
// its PR, under the head of the page, so on every tab: auto-merge waits
// while there's one. Each with its suggested answers (the hidden block
// under it) and room for another; they go to ronin in one comment that
// mentions it, which applies them and takes the questions out.

type PrQuestion = NonNullable<ItemDetail['questions']>[number];

// The questions of the item's PR, when the page decides it (ronin's, open).
export function questionsOf(v: ItemPage): PrQuestion[] {
  return v.decidable ? v.detail?.data?.questions ?? [] : [];
}

// Answers just sent, per item, so the card says so until ronin takes the
// questions out. Kept while the person is elsewhere.
const SENT_SHOWN_MS = 30 * 60_000;
const sent = new Map<string, { at: number; url: string }>();

// The comment: each answered question (its first line) with its answer.
export function answersText(questions: PrQuestion[], answers: Record<number, string>): string {
  const lines = questions.flatMap((q, i) => {
    const answer = answers[i]?.trim();
    return answer ? [`${i + 1}. ${q.text.split('\n')[0]}\n   Respuesta: ${answer}`] : [];
  });
  return lines.length ? `Respuestas a las preguntas de la descripción:\n\n${lines.join('\n')}` : '';
}

export function Questions({ v }: { v: ItemPage }) {
  const shell = useShell();
  const questions = questionsOf(v);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [other, setOther] = useState<Record<number, boolean>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!questions.length) return null;
  const id = v.item.id;
  const done = sent.get(id);
  const text = answersText(questions, answers);
  const answered = questions.filter((_, i) => answers[i]?.trim()).length;
  const pick = (i: number, answer: string, custom: boolean) => {
    setAnswers({ ...answers, [i]: answer });
    setOther({ ...other, [i]: custom });
  };
  const send = async () => {
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const r = (await ok(client.api.items[':id'].decision.$post({ param: itemParam(id), json: { decision: 'answer', text } }))) as { url: string };
      sent.set(id, { at: Date.now(), url: r.url });
      setAnswers({});
      setOther({});
      shell.toast('Le mandaste las respuestas a ronin.', r.url);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      setError(`No se pudo: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="pqs" aria-label="Preguntas">
      <h3>{oneOr(questions.length, 'Una pregunta para vos', `${questions.length} preguntas para vos`)} <span className="m">ronin no lo mergea hasta que estén respondidas</span></h3>
      {done && Date.now() - done.at < SENT_SHOWN_MS && <p className="pqs-sent">Ya le mandaste respuestas: ronin las aplica y saca las preguntas. <a href={done.url} target="_blank" rel="noopener">Ver ↗</a></p>}
      <ol>{questions.map((q, i) => (
        <li key={i}><Md text={q.text} repo={v.item.repo} />
          <div className="pqs-opts">{q.options.map((o) => <button key={o} aria-pressed={!other[i] && answers[i] === o} onClick={() => pick(i, answers[i] === o && !other[i] ? '' : o, false)}>{o}</button>)}
            <button aria-pressed={Boolean(other[i])} onClick={() => pick(i, '', !other[i])}>{q.options.length ? 'Otra respuesta' : 'Responder'}</button></div>
          {other[i] && <textarea rows={2} autoFocus placeholder="Tu respuesta" value={answers[i] ?? ''} onChange={(e) => pick(i, e.target.value, true)} />}
        </li>
      ))}</ol>
      {error && <p className="bad">{error}</p>}
      <footer><span className="m">Se comenta en el PR a tu nombre, mencionando a ronin.</span><button className="btn-s primary" disabled={!text || sending} onClick={() => void send()}>{answered ? `Mandar ${oneOr(answered, 'la respuesta', `${answered} respuestas`)}` : 'Mandar a ronin'}</button></footer>
    </section>
  );
}
