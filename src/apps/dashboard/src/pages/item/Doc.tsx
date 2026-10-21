import { useReducer } from 'react';
import type { ItemDetail, SnapshotItem } from '../../shell/hooks.js';
import { when } from '../../lib/format.js';
import { Md } from '../../lib/markdown.js';
import { Avatar, checksChip, Chips, sameLogin, type Doc } from './model.js';

// An issue or a PR as its tab shows it (#85): its body, where a PR stands,
// and its conversation as GitHub shows it. A portal request's Issue tab
// shows them too.

type Comment = Doc['comments'][number];
type Review = NonNullable<Doc['reviews']>[number];
type Thread = NonNullable<Doc['threads']>[number];
type Entry = { kind: 'comment'; at: string; c: Comment } | { kind: 'review'; at: string; r: Review } | { kind: 'thread'; at: string; t: Thread };

// The conversation, oldest first: general comments, a PR's reviews (those
// that say something) and its review threads, each thread where its first
// comment falls.
export function conversation(doc: Doc): Entry[] {
  return [
    ...doc.comments.map((c): Entry => ({ kind: 'comment', at: c.createdAt, c })),
    ...(doc.reviews ?? []).map((r): Entry => ({ kind: 'review', at: r.submittedAt, r })),
    ...(doc.threads ?? []).map((t): Entry => ({ kind: 'thread', at: t.comments[0].createdAt, t })),
  ].sort((a, b) => a.at.localeCompare(b.at));
}

const REVIEW_STATE: Record<string, [string, string]> = { APPROVED: ['ok', 'aprobó'], CHANGES_REQUESTED: ['crit', 'pidió cambios'], DISMISSED: ['idle', 'review descartada'], COMMENTED: ['idle', 'review'] };
// Past this, a body is shown cut, with "Ver todo" (ronin's external review summary runs long).
const CLIP_CHARS = 1800;

// What's opened (a resolved thread, a long review), or closed (an open
// thread), stays so while the person is elsewhere.
const expanded = new Set<string>();
export function useExpanded(): [Set<string>, (key: string, on: boolean) => void] {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  return [expanded, (key, on) => {
    if (on) expanded.add(key);
    else expanded.delete(key);
    redraw();
  }];
}

function Clipped({ id, text, repo }: { id: string; text: string; repo: string }) {
  const [open, set] = useExpanded();
  if (text.length <= CLIP_CHARS) return <Md text={text} repo={repo} />;
  return <><Md text={text} repo={repo} className={`md${open.has(id) ? '' : ' clip'}`} /><button className="link more" onClick={() => set(id, !open.has(id))}>{open.has(id) ? 'Ver menos' : 'Ver todo'}</button></>;
}

function Head({ author, url, at, extra }: { author: string; url: string; at: string; extra?: React.ReactNode }) {
  return <header><Avatar login={author} /><b>{author || 'alguien'}</b>{extra}<a href={url} target="_blank" rel="noopener">{when(at)}</a></header>;
}

// A review thread: resolved ones start folded, like on GitHub.
function ThreadEntry({ t, ronin, repo }: { t: Thread; ronin: string; repo: string }) {
  const [toggled, set] = useExpanded();
  const key = `t:${t.url}`;
  const open = t.isResolved ? toggled.has(key) : !toggled.has(key);
  // The end of the path is what tells files apart: the last two parts, the whole one on hover.
  const parts = (t.path ?? 'archivo').split('/');
  const where = `${parts.length > 2 ? '…/' : ''}${parts.slice(-2).join('/')}${t.line ? `:${t.line}` : ''}`;
  return (
    <details className={`cm thread${t.comments[0].author === ronin ? ' bot' : ''}`} open={open} onToggle={(e) => {
      const now = e.currentTarget.open;
      if (now !== open) set(key, now === t.isResolved);
    }}>
      <summary><span className="path" title={t.path ?? ''}>{where}</span>{t.isResolved && <span className="chip ok">resuelto</span>}{t.isOutdated && <span className="chip idle">desactualizado</span>}<span className="n">{t.comments.length} {t.comments.length === 1 ? 'comentario' : 'comentarios'}</span><span className="who">{t.comments[0].author}</span></summary>
      {t.comments.map((c, i) => <div key={c.url || i} className={`tc${i ? ' reply' : ''}`}><Head author={c.author} url={c.url} at={c.createdAt} /><Md text={c.body} repo={repo} /></div>)}
    </details>
  );
}

function EntryView({ e, ronin, doc, repo }: { e: Entry; ronin: string; doc: Doc; repo: string }) {
  const bot = (author: string) => (author === ronin ? ' bot' : '');
  if (e.kind === 'comment') return <article className={`cm${bot(e.c.author)}`}><Head author={e.c.author} url={e.c.url} at={e.c.createdAt} /><Clipped id={`c:${e.c.url}`} text={e.c.body} repo={repo} /></article>;
  if (e.kind === 'review') {
    const [cls, label] = REVIEW_STATE[e.r.state] ?? REVIEW_STATE.COMMENTED;
    return <article className={`cm${bot(e.r.author)}`}><Head author={e.r.author} url={doc.url} at={e.r.submittedAt} extra={<span className={`chip ${cls}`}>{label}</span>} />{e.r.body.trim() ? <Clipped id={`r:${e.r.author}:${e.r.submittedAt}`} text={e.r.body} repo={repo} /> : null}</article>;
  }
  return <ThreadEntry t={e.t} ronin={ronin} repo={repo} />;
}

export function Comments({ doc, ronin, repo }: { doc: Doc; ronin: string; repo: string }) {
  return <div className="comments">{conversation(doc).map((e, i) => <EntryView key={i} e={e} ronin={ronin} doc={doc} repo={repo} />)}</div>;
}

// The sections every PR ronin opens has (#195, PR_BODY_SECTIONS in
// platform/agents/prompts.ts), each under its heading; what it decided on its own
// stands out, it's what most needs a look. A body without them (an older
// PR) shows as it is.
const PR_SECTIONS = ['Qué se pidió', 'Qué cambió', 'Cómo se verificó', 'Decisiones propias', 'Fuera de alcance'];
function PrBody({ body, repo }: { body: string; repo: string }) {
  const parts = body.split(/^##[ \t]+(.+?)[ \t]*$/m);
  if (!parts.some((part, i) => i % 2 === 1 && PR_SECTIONS.includes(part))) return <Body body={body} repo={repo} />;
  const sections = [];
  for (let i = 1; i < parts.length; i += 2) sections.push(<section key={i} className={`psec${parts[i] === 'Decisiones propias' ? ' decis' : ''}`}><h3>{parts[i]}</h3><Md text={parts[i + 1].trim()} repo={repo} /></section>);
  return <>{parts[0].trim() ? <Md text={parts[0].trim()} repo={repo} className="md pre" /> : null}{sections}</>;
}

export const Body = ({ body, repo }: { body: string; repo: string }) => (body.trim() ? <Md text={body} repo={repo} /> : <div className="md"><p className="m">Sin descripción.</p></div>);

// Where a PR stands, on its tab (an issue's PR included): open or how it
// ended, its review and who approved it or asked for changes, auto-merge,
// checks and conflicts — what was only on GitHub.
function PrState({ item, doc }: { item: SnapshotItem; doc: Doc }) {
  if (doc.state === 'MERGED') return <div className="prstate"><span className="chip ok">mergeado</span></div>;
  if (doc.state === 'CLOSED') return <div className="prstate"><span className="chip idle">cerrado sin mergear</span></div>;
  // The sidebar's read of the PR: its checks, and a review just sent.
  const live = item.pr?.number === doc.number ? item.pr : null;
  const decision = live?.reviewDecision || doc.reviewDecision;
  const by = (state: string) => (doc.decisions ?? []).filter((x) => x.state === state).map((x) => x.author);
  const approved = by('APPROVED');
  const changes = by('CHANGES_REQUESTED');
  const chips: Array<[string, string]> = [doc.isDraft ? ['idle', 'draft'] : ['run', 'abierto']];
  if (decision === 'CHANGES_REQUESTED') chips.push(['warn', changes.length ? `cambios pedidos por ${changes.join(', ')}` : 'cambios pedidos']);
  else if (decision === 'APPROVED') chips.push(['ok', approved.length ? `aprobado por ${approved.join(', ')}` : 'aprobado']);
  else if (approved.length) chips.push(['warn', `aprobado por ${approved.join(', ')}${decision === 'REVIEW_REQUIRED' ? ', faltan aprobaciones' : ''}`]);
  else chips.push(['plain', decision === 'REVIEW_REQUIRED' ? 'falta la aprobación' : 'sin aprobar']);
  chips.push(doc.labels.includes('ronin:auto-merge') ? ['ok', 'auto-merge activo'] : ['plain', 'sin auto-merge']);
  const checks = checksChip(live?.checks);
  if (checks) chips.push(checks);
  if (doc.mergeable === 'CONFLICTING') chips.push(['crit', `conflictos con ${doc.baseRefName}`]);
  return <div className="prstate"><Chips chips={chips} /></div>;
}

// The issue's or the PR's tab: the other one's link when it's not the
// item itself, its body and its conversation.
export function DocPage({ item, d, tab }: { item: SnapshotItem; d: ItemDetail; tab: 'issue' | 'pr' }) {
  const doc = (tab === 'issue' ? d.issue : d.pr)!;
  const other = (tab === 'issue') !== (item.kind === 'issue');
  const n = conversation(doc).length;
  return <>
    <div className="page">{other && <a className="other" href={doc.url} target="_blank" rel="noopener">{doc.title} <span className="m">{tab === 'pr' ? 'PR' : 'Issue'} #{doc.number} ↗</span></a>}
      <div className="meta"><Avatar login={doc.author} /><b>{doc.author}</b><span>{when(doc.createdAt)}</span></div>{tab === 'pr' && <PrState item={item} doc={doc} />}
      {tab === 'pr' && sameLogin(doc.author, d.ronin) ? <PrBody body={doc.body} repo={item.repo} /> : <Body body={doc.body} repo={item.repo} />}</div>
    <section className="conv"><h3>Comentarios {tab === 'pr' ? 'del PR' : 'del issue'}{n ? <> <span className="c">{n}</span></> : null}</h3>{n
      ? <Comments doc={doc} ronin={d.ronin} repo={item.repo} />
      : <p className="m">Nadie comentó todavía.</p>}</section>
  </>;
}
