import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, type ReactNode } from 'react';
import { ApiError, client, ok, type Snapshot, type Today as TodayData } from '../../api.js';
import { useRepoColor, useShell, useSnapshot } from '../../shell/hooks.js';
import { hhmm, pct, repoShort, Sparkline } from '../../lib/format.js';
import { duration, money, RUN_STATE, runTitle } from '../../lib/runs.js';
import { hideTip, tip } from '../../lib/tip.js';
import { AttentionCard } from './Attention.js';
import { Breakdown, CycleCard } from './Cycle.js';
import { attention, EVERY_MS } from './model.js';

const MIN = 60e3;

// Hoy, the dashboard's home: the day's numbers, what waits on a person, each
// repo's Linear cycle and the last 12 hours of runs. What the sidebar has
// (the items, the previews, the repos) it reads from the shell's snapshot,
// and draws again with each one.
export function Today() {
  const shell = useShell();
  const snap = useSnapshot();
  const query = useQuery({
    queryKey: ['today'],
    queryFn: () => ok(client.api.today.$get()),
    refetchInterval: EVERY_MS,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) shell.unauthorized(query.error.message);
  }, [query.error, shell]);

  const now = Date.now();
  const t = query.data;
  const running = snap.items.filter((i) => i.status === 'running').length;
  const a = attention(snap, now);
  const lead = [
    running ? `${running} ${running === 1 ? 'agente trabajando' : 'agentes trabajando'}` : 'ningún agente trabajando',
    a.blocked.length ? `${a.blocked.length} ${a.blocked.length === 1 ? 'issue espera' : 'issues esperan'} una respuesta` : null,
    a.review.length ? `${a.review.length} ${a.review.length === 1 ? 'PR espera' : 'PRs esperan'} tu review o tu merge` : null,
  ].filter(Boolean).join(', ');
  const date = new Date(now).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
  const head = <><h1>Hoy</h1><p className="lead">{date[0].toUpperCase() + date.slice(1)} · {lead}.</p></>;
  if (!t) return <div className="today">{head}<div className="empty">Cargando…</div></div>;

  const cycles = t.cycles;
  return (
    <div className="today">
      {head}
      <Tiles t={t} />
      <div className={`hgrid ${cycles.length ? '' : 'one'}`}>
        <AttentionCard a={a} snap={snap} now={now} />
        {cycles.length > 0 && <div className="rcol">{cycles.map((c) => <Fragment key={`${c.repo}-${c.number}`}><CycleCard c={c} several={cycles.length > 1} now={now} /><Breakdown c={c} /></Fragment>)}</div>}
      </div>
      <Timeline t={t} snap={snap} now={now} />
    </div>
  );
}

// The day's numbers, each with its week as a sparkline (today last).
function Tiles({ t }: { t: TodayData }) {
  const d = t.today;
  const week = t.week ?? [];
  const tile = (label: string, value: ReactNode, sub: ReactNode, series: Array<number | null>) => (
    <div className="tile"><div className="l">{label}</div><div className="v">{value}</div><div className="d">{sub}</div>{series.length > 1 && <Sparkline values={series} />}</div>
  );
  const cost = [
    t.yesterday.costUsd !== undefined ? <>ayer <b>{t.yesterday.costUsd ? money(t.yesterday.costUsd) : 'US$0'}</b></> : null,
    d.failed ? `${d.failed} con error` : null,
    d.usageLimit ? `${d.usageLimit} sin cuota` : null,
  ].filter(Boolean);
  return (
    <div className="tiles">
      {tile('Corridas hoy', d.runs, <>ayer <b>{t.yesterday.runs}</b></>, week.map((w) => w.runs))}
      {tile('Terminaron bien', d.finished ? pct(d.ok / d.finished) : '—', d.finished ? <><b>{d.ok}</b> de {d.finished} terminadas</> : 'ninguna terminada todavía', week.map((w) => (w.finished ? w.ok / w.finished : null)))}
      {tile('Duración mediana', d.medianMs !== null ? duration(d.medianMs) : '—', d.p90Ms !== null ? <>p90 <b>{duration(d.p90Ms)}</b></> : ' ', week.map((w) => w.medianMs))}
      {tile('Costo hoy', d.costUsd ? money(d.costUsd) : 'US$0', cost.length ? cost.map((part, i) => <Fragment key={i}>{i ? ', ' : ''}{part}</Fragment>) : 'sin errores', week.map((w) => w.costUsd))}
    </div>
  );
}

// Each repo's runs of the last 12 hours, in as many rows as they overlap.
function Timeline({ t, snap, now }: { t: TodayData; snap: Snapshot; now: number }) {
  const shell = useShell();
  const repoColor = useRepoColor();
  const from = Date.parse(t.from);
  const span = now - from;
  const pos = (ms: number) => Math.max(0, Math.min(100, ((ms - from) / span) * 100));
  const lanes = snap.repos.map((repo) => {
    const rows: number[] = [];
    const bars = t.timeline.filter((run) => run.repo === repo).map((run) => {
      const start = pos(Date.parse(run.startedAt));
      const end = run.state === 'running' ? 100 : pos(Date.parse(run.endedAt ?? run.startedAt));
      let row = rows.findIndex((last) => last < start - 0.4);
      if (row < 0) row = rows.push(-1) - 1;
      rows[row] = Math.max(end, start + 0.4);
      const item = snap.items.find((i) => i.id === run.itemId);
      const [, , label] = RUN_STATE[run.state] ?? RUN_STATE.error;
      const when = `${hhmm(run.startedAt)}${run.endedAt ? `–${hhmm(run.endedAt)}` : ', en curso'}`;
      const text = `${runTitle(run)}${item ? `\n${item.title}` : ''}\n${when}, ${label}`;
      const cls = run.state === 'running' ? 'live' : ['error', 'timeout', 'cut'].includes(run.state) ? 'fail' : run.state === 'usage_limit' ? 'quota' : '';
      return (
        <button key={run.runId} className={`bar ${cls}`} style={{ left: `${start}%`, width: `max(6px,${end - start}%)`, top: `${6 + row * 15}px`, backgroundColor: repoColor(repo) }}
          aria-label={text.replace(/\n/g, ', ')} {...tip(text)}
          onClick={() => {
            hideTip();
            shell.openRun(run.itemId, run.runId);
          }} />
      );
    });
    const height = Math.max(1, rows.length) * 15 + 10;
    return <div key={repo} className="lane"><span className="nm">{repoShort(repo)}</span><div className="track" style={{ height: `${height}px` }}>{bars}<span className="nowl" /></div></div>;
  });
  const ticks = [0, 2, 4, 6, 8, 10, 12].map((h) => <span key={h} className={h % 4 === 2 ? 'minor' : ''} style={{ left: `${(h / 12) * 100}%` }}>{h === 12 ? 'ahora' : hhmm(new Date(from + h * 60 * MIN).toISOString())}</span>);
  return (
    <div className="day">
      <h2>Últimas 12 horas<span className="legend">{snap.repos.map((repo) => <span key={repo}><i style={{ background: repoColor(repo) }} />{repoShort(repo)}</span>)}<span><i className="lg-fail" />terminó con error</span></span></h2>
      {t.timeline.length ? null : <p className="note" style={{ margin: '0 0 8px' }}>Ninguna corrida de agentes en las últimas 12 horas.</p>}
      {lanes}
      <div className="axis"><span /><div className="ticks">{ticks}</div></div>
    </div>
  );
}
