import { useLayoutEffect, useRef } from 'react';

// An agent's run as the pages that list them show it (a portal request's,
// a meeting's): its card, its transcript and how it ended, written as app.js
// wrote them.

const MIN = 60e3;

// [the dot's class, a chip's, in words].
export const RUN_STATE: Record<string, [string, string, string]> = {
  running: ['live', 'run', 'trabajando'],
  ok: ['ok', 'ok', 'terminó bien'],
  error: ['crit', 'crit', 'falló'],
  timeout: ['crit', 'crit', 'se pasó del tiempo'],
  usage_limit: ['warn', 'warn', 'sin cuota de Claude'],
  cut: ['crit', 'crit', 'se cortó'],
  blocked: ['crit', 'crit', 'bloqueado'],
  waiting: ['warn', 'warn', 'esperando a alguien'],
  open: ['pending', 'idle', 'abierto'],
};
const VERB: Record<string, string> = { Bash: 'Corrió', Read: 'Leyó', Edit: 'Editó', MultiEdit: 'Editó', Write: 'Escribió', NotebookEdit: 'Editó', Grep: 'Buscó', Glob: 'Buscó', WebFetch: 'Abrió', WebSearch: 'Buscó en la web', Task: 'Lanzó un agente', Agent: 'Lanzó un agente', TodoWrite: 'Anotó tareas' };
// A task type in words (fix-issue → "Resolver issue").
const TYPE: Record<string, string> = {
  'plan': 'Planificar', 'implement-slice': 'Implementar slice', 'fix-issue': 'Resolver issue', 'fix-review': 'Responder review',
  'fix-e2e': 'Arreglar e2e', 'review-request': 'Pedido en review', 'fix-comments': 'Aplicar comentarios',
  'fix-comments-external': 'Aplicar comentarios', 'resolve-conflicts': 'Resolver conflictos', 'thread-reply-external': 'Responder hilo',
  'external-review': 'Review externa', 'internal-review': 'Review interna', 'fix-internal-review': 'Atender review interna', 'spike': 'Spike', 'write-spec': 'Escribir spec', 'revise-spec': 'Conversar el spec',
  'update-changelog': 'Changelog', 'explore-inventory': 'Inventario de exploración', 'explore-focus': 'Foco de exploración',
  'explore-function': 'Explorar', 'explore-evaluate': 'Evaluar exploración', 'explore-redo-after': 'Rehacer captura',
  'explore-feedback': 'Comentarios de exploración', 'commit-subject': 'Mensaje de commit', 'prepare-preview-data': 'Datos de preview', 'preview-seed-catalog': 'Catálogo de seeds', 'preview-data-triage': 'Revisión de los seeds', 'preview-data-delta': 'Datos de preview al actualizarse', 'portal-request': 'Pedido del portal', 'portal-interview': 'Respuestas de la entrevista', 'portal-prototype': 'Prototipo del portal', 'portal-reproduce': 'Reproducción del portal', 'meeting-read': 'Lectura de reunión',
};
export const typeName = (type: string) => TYPE[type] ?? type;
// Runs that are steps of one thing (platform/agents/run-group.ts): a preview's seed
// catalog, "¿alcanzan los seeds?" and its data are one preview.
const GROUP_NAME: Record<string, string> = { preview: 'Preview' };
export const groupName = (run: { group?: string }) => (run.group ? GROUP_NAME[run.group.split(':')[0]] : undefined);
// What a run is: its group's name, or its own task's.
export const runKind = (run: { group?: string; taskType: string }) => groupName(run) ?? typeName(run.taskType);
// A step of a group says which one: "Preview: Revisión de los seeds".
export const runTitle = (run: { group?: string; taskType: string }) => (groupName(run) ? `${groupName(run)}: ${typeName(run.taskType)}` : typeName(run.taskType));

export function duration(ms: number): string {
  const m = Math.round(ms / MIN);
  return m < 1 ? `${Math.round(ms / 1000)} s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
export const money = (usd: number) => (usd < 0.01 ? 'menos de US$0,01' : `US$${usd.toFixed(2).replace('.', ',')}`);
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

export const Dot = ({ cls }: { cls: string }) => <span className={`dot ${cls}`} aria-hidden="true" />;
export const RunDot = ({ state }: { state: string }) => <Dot cls={(RUN_STATE[state] ?? RUN_STATE.error)[0]} />;

// How long it's been going: the shell's clock (tickClocks) moves every
// [data-since] each second; this only writes the first.
export function Since({ at, className }: { at: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = clock(Date.now() - Date.parse(at));
  }, [at]);
  return <span ref={ref} className={className} data-since={at} />;
}

export interface RunLike {
  runId: string;
  taskType: string;
  state: string;
  group?: string;
  issueNumber?: number;
  prNumber?: number;
  startedAt: string;
  durationMs?: number;
  costUsd?: number;
  billing?: 'api';
  lastStep?: string;
}

export function RunCard({ run, onOpen }: { run: RunLike; onOpen: (runId: string) => void }) {
  const live = run.state === 'running';
  const facts = [run.billing === 'api' ? 'por API' : null, run.durationMs !== undefined ? duration(run.durationMs) : null, run.costUsd !== undefined ? money(run.costUsd) : null, RUN_STATE[run.state]?.[2]].filter(Boolean).join(' · ');
  return (
    <div className="pd-run"><RunDot state={run.state} /><span className="nm">{typeName(run.taskType)}{run.issueNumber ? ` · #${run.issueNumber}` : run.prNumber ? ` · PR #${run.prNumber}` : ''}</span>
      <span className="st">{live ? <Since at={run.startedAt} /> : facts}</span>
      <button className="go" onClick={() => onOpen(run.runId)}>{live ? 'Ver en vivo' : 'Ver corrida'} →</button>
      {run.lastStep && <span className="last">{live ? '▸' : 'último:'} {run.lastStep}</span>}</div>
  );
}

export interface RunLine {
  type: string;
  text?: string;
  name?: string;
  summary?: unknown;
}

function Step({ line }: { line: RunLine }) {
  if (line.type === 'text') return <div className="say">{line.text}</div>;
  if (line.type === 'tool_error') return <div className="out">{line.text}</div>;
  if (line.type === 'tool') {
    const summary = String(line.summary ?? '').replace(/^\$ /, '');
    return <div className="step"><b>{VERB[line.name ?? ''] ?? line.name}</b> <span className="arg">{summary}</span></div>;
  }
  return null;
}

// A run's transcript: its steps, or that there are none yet.
export function Steps({ lines }: { lines: RunLine[] }) {
  const shown = lines.filter((line) => ['text', 'tool_error', 'tool'].includes(line.type));
  return shown.length ? <>{shown.map((line, i) => <Step key={i} line={line} />)}</> : <div className="empty">El agente todavía no hizo nada.</div>;
}

export function Ending({ summary }: { summary: { state: string; durationMs?: number; costUsd?: number; error?: string } }) {
  const extra = [summary.durationMs !== undefined ? duration(summary.durationMs) : null, summary.costUsd !== undefined ? money(summary.costUsd) : null].filter(Boolean).join(', ');
  switch (summary.state) {
    case 'ok': return <div className="end ok"><b>Terminó bien.</b> {extra}</div>;
    case 'timeout': return <div className="end crit"><b>Se pasó del tiempo límite</b> y se cortó. {extra}</div>;
    case 'usage_limit': return <div className="end warn"><b>Se quedó sin cuota de Claude.</b> Se reintenta cuando la cuenta se reinicie.</div>;
    case 'cut': return <div className="end crit"><b>Se cortó:</b> el proceso de ronin terminó sin cerrar la corrida.</div>;
    case 'error': return <div className="end crit"><b>Falló.</b> {summary.error ?? ''}</div>;
    default: return null;
  }
}

// What the agent did, step by step, and how it ended.
export function Transcript({ run }: { run: { lines: RunLine[]; summary: { state: string; durationMs?: number; costUsd?: number; error?: string } } }) {
  return <div className="tx pd-tx"><Steps lines={run.lines} /><Ending summary={run.summary} /></div>;
}

// What's on its way, in the shape it'll have (#372): the page doesn't jump
// when it comes. Only the four that take a while: an item's page, a run's
// transcript, the requests' list and the runs' history.
const SKELETONS: Record<'ficha' | 'tx' | 'list' | 'hist', string[]> = {
  ficha: ['h', 's', 'gap', '', 'm', '', 's'],
  tx: ['m', 's', '', 'm', 's', ''],
  list: ['row', 'row', 'row', 'row'],
  hist: ['s', 'row', 'row', 'row'],
};
export function Skeleton({ kind, label = 'Cargando…' }: { kind: keyof typeof SKELETONS; label?: string }) {
  return <div className={`skel skel-${kind}`} role="status" aria-busy="true"><span className="sr">{label}</span>{SKELETONS[kind].map((cls, i) => <i key={i} className={cls} aria-hidden="true" />)}</div>;
}
