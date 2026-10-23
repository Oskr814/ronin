import { Fragment, type ComponentType, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { SnapshotItem } from '@apps/dashboard/src/shell/hooks.js';
import { when } from '@apps/dashboard/src/lib/format.js';
import { Md } from '@apps/dashboard/src/lib/markdown.js';
import { useSession } from '@apps/dashboard/src/shell/hooks.js';
import { useExpanded } from '../Doc.js';
import { Avatar } from '../model.js';
import type { Content } from './Files.js';
import { hunksOf, isSending, MORE_LINES, SENDING, type Line, type PendingReview, type PrFile, type SeenThread, type Side } from './diff.js';
import type { PrFiles } from './model.js';

// A file's diff (#111): its hunks, the unchanged lines opened around them,
// and each thread under the line it's on, with the composer where a comment
// is being written.

// A comment being written: where, and what.
export interface Composing {
  path?: string;
  subject?: 'line' | 'file';
  side?: Side;
  // The hunk a range can't go past, and the line it started on.
  hunk?: number;
  anchor?: number;
  line?: number;
  startLine?: number;
  // A reply to a thread (to its last comment), or a pending comment edited.
  reply?: string;
  commentId?: number;
  edit?: string;
  text: string;
  preview: boolean;
  sending?: 'now' | 'review' | 'edit' | false;
  error?: string | null;
}

// What a file's card needs from the tab.
export interface FilesCtx {
  item: SnapshotItem;
  data: PrFiles;
  ronin: string | undefined;
  review: PendingReview | null;
  comp: Composing | null;
  box: RefObject<HTMLTextAreaElement | null>;
  busy: Set<string>;
  split: boolean;
  contents: Map<string, Content>;
  exp: Record<string, Record<string, number>>;
  setComp(c: Composing | null): void;
  openComposer(spot: Omit<Composing, 'text' | 'preview'> & { text?: string }): void;
  focus(): void;
  send(how?: 'now' | 'review' | 'edit'): Promise<void>;
  resolve(threadId: string, resolved: boolean): Promise<void>;
  deletePending(nodeId: string): Promise<void>;
  showMore(path: string, at: string, more: number): Promise<void>;
  suggest(): void;
}

type ComposerT = ComponentType<{ ctx: FilesCtx; file: PrFile | null }>;

// A row of the diff's table: a gap to open, a hunk's head, a line (on a
// phone or unified), or a deletion next to its addition (side by side).
type Under = { threads: SeenThread[]; comp: boolean };
type Row =
  | { kind: 'gap'; at: string; label: string }
  | { kind: 'hunk'; text: string }
  | { kind: 'line'; l: Line; hunk: number | null; under: Under | null }
  | { kind: 'pair'; left?: Line; right?: Line; hunk: number; under: Under | null };

// The rows of one file's diff, and which threads found their line.
export function diffRows(ctx: FilesCtx, file: PrFile, threads: SeenThread[]): { rows: Row[]; placed: Set<SeenThread> } {
  const placed = new Set<SeenThread>();
  const at = new Map<string, SeenThread[]>();
  for (const t of threads) if (t.subject === 'line' && t.line !== null && !t.isOutdated) at.set(`${t.side}:${t.line}`, [...(at.get(`${t.side}:${t.line}`) ?? []), t]);
  const c = ctx.comp;
  // Under a line: its threads, then the composer when it ends there.
  const under = (side: Side, num: number | undefined): Under | null => {
    if (num === undefined) return null;
    const list = at.get(`${side}:${num}`) ?? [];
    for (const t of list) placed.add(t);
    const comp = Boolean(c && c.path === file.path && c.subject === 'line' && !c.reply && c.side === side && c.line === num);
    return list.length || comp ? { threads: list, comp } : null;
  };
  const both = (a: Under | null, b: Under | null): Under | null => (a || b ? { threads: [...(a?.threads ?? []), ...(b?.threads ?? [])], comp: Boolean(a?.comp || b?.comp) } : null);
  const content = ctx.contents.get(`${ctx.item.id}|${file.path}`);
  const lines = content?.lines;
  const shown = ctx.exp[file.path] ?? {};
  const hunks = hunksOf(file);
  const rows: Row[] = [];
  const lineRow = (l: Line, hunk: number | null) => rows.push({ kind: 'line', l, hunk, under: under(l.t === 'del' ? 'LEFT' : 'RIGHT', l.t === 'del' ? l.o : l.n) });
  // Lines shown around the hunks can't be commented: GitHub takes only lines of the diff.
  const ctxRow = (o: number, n: number) => lineRow({ t: 'eq', o, n, text: lines![n - 1] ?? '' }, null);
  let prevNew = 0;
  hunks.forEach((h, k) => {
    const gap = h.newStart - 1 - prevNew;
    if (gap > 0) {
      const open = lines ? Math.min(shown[k] ?? 0, gap) : 0;
      if (gap - open > 0) rows.push({ kind: 'gap', at: String(k), label: `Mostrar ${Math.min(MORE_LINES, gap - open)} líneas más (${gap - open} sin cambios)` });
      for (let n = h.newStart - open; n < h.newStart; n++) ctxRow(n + h.oldStart - h.newStart, n);
    }
    rows.push({ kind: 'hunk', text: `@@ −${h.oldStart} +${h.newStart} @@ ${h.ctx}` });
    if (!ctx.split) for (const l of h.lines) lineRow(l, k);
    else {
      // Side by side: a run of deletions next to the additions that replace it.
      const pair = (left: Line | undefined, right: Line | undefined) => rows.push({ kind: 'pair', left, right, hunk: k, under: both(left && left.t === 'del' ? under('LEFT', left.o) : null, right ? under('RIGHT', right.n) : null) });
      for (let i = 0; i < h.lines.length;) {
        if (h.lines[i].t === 'eq') {
          pair(h.lines[i], h.lines[i]);
          i++;
          continue;
        }
        const dels: Line[] = [];
        const adds: Line[] = [];
        while (i < h.lines.length && h.lines[i].t === 'del') dels.push(h.lines[i++]);
        while (i < h.lines.length && h.lines[i].t === 'add') adds.push(h.lines[i++]);
        for (let j = 0; j < Math.max(dels.length, adds.length); j++) pair(dels[j], adds[j]);
      }
    }
    prevNew = h.newEnd;
  });
  // After the last hunk: how much is left is known once the file is read.
  const last = hunks[hunks.length - 1];
  if (last && file.status !== 'added') {
    const tail = lines ? lines.length - prevNew : null;
    const open = lines && tail !== null ? Math.min(shown.end ?? 0, tail) : 0;
    for (let n = prevNew + 1; n <= prevNew + open; n++) ctxRow(n + last.oldEnd - last.newEnd, n);
    if (tail === null) rows.push({ kind: 'gap', at: 'end', label: 'Mostrar más líneas' });
    else if (tail - open > 0) rows.push({ kind: 'gap', at: 'end', label: `Mostrar ${Math.min(MORE_LINES, tail - open)} líneas más (${tail - open} hasta el final)` });
  }
  return { rows, placed };
}

const MARK = { add: '+', del: '−', eq: ' ' };

export function DiffTable({ ctx, file, rows, Composer }: { ctx: FilesCtx; file: PrFile; rows: Row[]; Composer: ComposerT }) {
  const cols = ctx.split ? 4 : 3;
  const c = ctx.comp;
  const content = ctx.contents.get(`${ctx.item.id}|${file.path}`);
  // The line being commented on, or the range: on one side, inside one hunk.
  const sel = (side: Side, num: number | undefined) => Boolean(c && num !== undefined && c.path === file.path && c.subject === 'line' && !c.reply && c.side === side && num >= (c.startLine ?? c.line!) && num <= c.line!);
  // A line number: comment it; with Shift, from the line already chosen to this one (same side, same hunk).
  const pick = (e: MouseEvent, side: Side, line: number, hunk: number) => {
    if (e.shiftKey && c && c.path === file.path && c.subject === 'line' && !c.reply && c.side === side && c.hunk === hunk) {
      const from = Math.min(c.anchor!, line);
      const to = Math.max(c.anchor!, line);
      ctx.openComposer({ path: file.path, subject: 'line', side, hunk, anchor: c.anchor, line: to, ...(from !== to ? { startLine: from } : {}) });
      return;
    }
    ctx.openComposer({ path: file.path, subject: 'line', side, hunk, anchor: line, line });
  };
  // A line number that opens the composer: its side and number, and its hunk (a range can't go past it).
  const num = (cls: string, side: Side, n: number | undefined, hunk: number | null) => (n === undefined
    ? <td className={`n ${cls}`} />
    : hunk === null ? <td className={`n ${cls}`}>{n}</td>
      : <td className={`n ${cls} fl`} title="Comentar esta línea (Shift+clic: hasta acá)" onClick={(e) => pick(e, side, n, hunk)}>{n}</td>);
  const threads = (u: Under | null) => u && <tr className="fthreads"><td colSpan={cols}>{u.threads.map((t) => <FileThread key={t.url} ctx={ctx} t={t} Composer={Composer} />)}{u.comp && <Composer ctx={ctx} file={file} />}</td></tr>;
  const cell = (l: Line | undefined, side: Side, n: number | undefined, hunk: number) => {
    if (!l) return <><td className="n none" /><td className="c none" /></>;
    const on = sel(side, n) ? ' sel' : '';
    return <>{num(`${l.t}${on}`, side, n, hunk)}<td className={`c ${l.t}${on}`}><span className="m">{MARK[l.t]}</span>{l.text}</td></>;
  };
  const row = (r: Row, i: number): ReactNode => {
    switch (r.kind) {
      case 'gap': return <tr key={i} className="fgap"><td colSpan={cols}><button disabled={content?.loading} onClick={() => void ctx.showMore(file.path, r.at, MORE_LINES)}>↕ {content?.loading ? 'Leyendo…' : r.label}</button>{content?.error && <> <span className="bad">{content.error}</span></>}</td></tr>;
      case 'hunk': return <tr key={i} className="fhunk"><td colSpan={cols}>{r.text}</td></tr>;
      case 'line': {
        const side = r.l.t === 'del' ? 'LEFT' : 'RIGHT';
        return <Fragment key={i}><tr className={`ln ${r.l.t}${sel(side, side === 'LEFT' ? r.l.o : r.l.n) ? ' sel' : ''}`}>{num('', 'LEFT', r.l.o, r.hunk)}{num('', 'RIGHT', r.l.n, r.hunk)}<td className="c"><span className="m">{MARK[r.l.t]}</span>{r.l.text}</td></tr>{threads(r.under)}</Fragment>;
      }
      case 'pair': return <Fragment key={i}><tr className="ln">{cell(r.left, 'LEFT', r.left?.o, r.hunk)}{cell(r.right, 'RIGHT', r.right?.n, r.hunk)}</tr>{threads(r.under)}</Fragment>;
    }
  };
  return (
    <table className={`fdiff${ctx.split ? ' split' : ''}`}>
      {ctx.split ? <colgroup><col className="cn" /><col /><col className="cn" /><col /></colgroup> : <colgroup><col className="cn" /><col className="cn" /><col /></colgroup>}
      <tbody>{rows.map(row)}</tbody>
    </table>
  );
}

// A thread on the diff: GitHub's comments, then what the person's review
// adds (only they see it until they send it), and how to answer.
export function FileThread({ ctx, t, Composer }: { ctx: FilesCtx; t: SeenThread; Composer: ComposerT }) {
  const session = useSession();
  const [expanded, setExpanded] = useExpanded();
  const key = `t:${t.url}`;
  // Resolved threads start folded, like on GitHub.
  const open = t.isResolved ? expanded.has(key) : !expanded.has(key);
  const where = t.subject === 'file' ? 'Sobre el archivo' : t.isOutdated || t.line === null ? `Línea ${t.originalLine ?? '?'}, en código que ya cambió` : `${t.startLine && t.startLine !== t.line ? `Líneas ${t.startLine}–${t.line}` : `Línea ${t.line}`}${t.side === 'LEFT' ? ', versión anterior' : ''}`;
  const me = session.me;
  const c = ctx.comp;
  const replying = Boolean(c && c.reply === t.id);
  const busy = ctx.busy.has(t.id);
  const count = t.comments.length + (t.pending?.length ?? 0);
  return (
    <details className={`dthread${t.mine ? ' mine' : ''}`} open={open || replying || Boolean(t.pending)} onToggle={(e) => {
      // A thread's default is open unless resolved; what's kept is the change from it.
      setExpanded(key, e.currentTarget.open === t.isResolved);
    }}>
      <summary><span>{where}</span>{t.isResolved && <span className="chip ok">resuelto</span>}{t.isOutdated && <span className="chip idle">desactualizado</span>}{t.pending && <span className="pendl">{t.mine ? 'en tu revisión' : `${t.pending.length} en tu revisión`}</span>}<span className="n">{count} {count === 1 ? 'comentario' : 'comentarios'}</span></summary>
      {t.comments.map((x) => <div key={x.id} className={`tc${isSending(x) ? ' sending' : ''}`}><Avatar login={x.author} /><div><header><b>{x.author || 'alguien'}</b>{x.author === ctx.ronin && <span className="botl">bot</span>}{isSending(x) ? <span className="chip idle">enviando…</span> : <a href={x.url} target="_blank" rel="noopener">{when(x.createdAt)}</a>}</header><Md text={x.body} repo={ctx.item.repo} /></div></div>)}
      {(t.pending ?? []).map((x) => (c?.edit === x.nodeId
        ? <Composer key={x.nodeId} ctx={ctx} file={null} />
        : <div key={x.nodeId} className="tc pend" id={`p-${x.nodeId}`}><Avatar login={me} /><div><header><b>{me}</b><span className="pendl">Pendiente</span><span className="pact"><button onClick={() => ctx.openComposer({ path: t.path, edit: x.nodeId, text: x.body })}>Editar</button><button disabled={ctx.busy.has(x.nodeId)} onClick={() => void ctx.deletePending(x.nodeId)}>Borrar</button></span></header><Md text={x.body} repo={ctx.item.repo} /></div></div>))}
      {replying
        ? <Composer ctx={ctx} file={null} />
        // A thread the review starts takes no replies or resolving until it's sent.
        // Nor one still on its way.
        : !t.mine && !t.id.startsWith(SENDING) && <div className="tfoot"><button className="treply" onClick={() => ctx.openComposer({ path: t.path, reply: t.id, commentId: t.comments[t.comments.length - 1].id })}>Responder…</button><button className="btn-s" disabled={busy} onClick={() => void ctx.resolve(t.id, !t.isResolved)}>{busy ? '…' : t.isResolved ? 'Reabrir' : 'Resolver conversación'}</button></div>}
    </details>
  );
}
