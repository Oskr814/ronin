import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { ApiError, client, ok, type SubscriptionAccount } from '../../api.js';
import { useShell } from '../../shell/hooks.js';
import { typeName } from '../../lib/runs.js';
import { DAY_MS, isMobile, pct } from '../../lib/format.js';
import { tip } from '../../lib/tip.js';
import { useViewState } from '../../lib/view-state.js';
import { ago, useNow } from '../../../../../ui/time.js';
import { day, left, money, num, when } from './format.js';
import { Head } from './Head.js';

// Métricas → Suscripción (#234): how much of each Claude account's plan gets
// used, whoever uses it, and how much of that is ronin (an estimate).
// Computed by domains/metrics/subscription.ts; this only draws it. ronin is
// --repo-0, other uses --repo-1 (the pair passes the colorblind and contrast
// checks in both themes), what's left unused the raised gray.

const EVERY_MS = 5 * 60_000;
const RONIN = 'var(--repo-0)';
const OTHERS = 'var(--repo-1)';
// The whole account, while there's no estimate of ronin's part yet.
const ALL = 'var(--faint)';

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <details className="su-tbl"><summary>Ver como tabla</summary><div className="mt-scroll"><table className="su-table">
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table></div></details>
  );
}

// The week in course: the cumulative use, ronin's estimated part under the
// others', the projection to the reset and a mark for the last measurement.
function WeekChart({ c }: { c: SubscriptionAccount }) {
  const w = c.week!;
  const narrow = isMobile();
  const W = narrow ? 360 : 640, H = narrow ? 220 : 210, pad = { l: 34, r: narrow ? 30 : 42, t: 12, b: 26 };
  const start = Date.parse(w.start), end = Date.parse(w.resetsAt);
  const x = (ms: number) => pad.l + ((ms - start) / (end - start)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - Math.min(v, 1)) * (H - pad.t - pad.b);
  const pts = [{ at: w.start, used: 0, ronin: w.ronin === null ? null : 0 }, ...w.series];
  const line = (key: (p: (typeof pts)[number]) => number) => pts.map((p) => `${x(Date.parse(p.at))},${y(key(p))}`).join(' L');
  const last = pts.at(-1)!;
  const lx = x(Date.parse(last.at));
  const out = w.projection.exhaustsAt && Date.parse(w.projection.exhaustsAt) < end;
  const px = out ? x(Date.parse(w.projection.exhaustsAt!)) : x(end);
  const pv = out ? 1 : w.projection.close;
  const xs = pts.map((p) => x(Date.parse(p.at)));
  const days: number[] = [];
  for (let d = 0; d < 7; d += narrow ? 2 : 1) days.push(d);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Uso de la semana de ${c.account}`}>
      {(narrow ? [0, 0.5] : [0, 0.25, 0.5, 0.75]).map((v) => [
        <line key={`l${v}`} x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--rule)" strokeDasharray={v ? '2 3' : undefined} />,
        <text key={`t${v}`} x={pad.l - 6} y={y(v) + 3} textAnchor="end">{v * 100}%</text>,
      ])}
      <line x1={pad.l} x2={W - pad.r} y1={y(1)} y2={y(1)} stroke="var(--muted)" /><text x={pad.l - 6} y={y(1) + 3} textAnchor="end">100%</text>
      {days.map((d) => <text key={`d${d}`} x={x(start + (d + 0.5) * DAY_MS)} y={H - 8} textAnchor="middle">{day(start + d * DAY_MS)}</text>)}
      {w.ronin === null
        ? <path d={`M${x(start)},${y(0)} L${line((p) => p.used)} L${lx},${y(0)} Z`} fill={ALL} opacity=".55" />
        : <>
          <path d={`M${x(start)},${y(0)} L${line((p) => p.ronin!)} L${lx},${y(0)} Z`} fill={RONIN} opacity=".9" />
          <path d={`M${line((p) => p.used)} L${[...pts].reverse().map((p) => `${x(Date.parse(p.at))},${y(p.ronin!)}`).join(' L')} Z`} fill={OTHERS} opacity=".9" />
        </>}
      <path d={`M${lx},${y(last.used)} L${px},${y(pv)}`} stroke="var(--ink-2)" strokeWidth="2" strokeDasharray="4 4" fill="none" />
      <text x={px + 5} y={y(pv) + 4} style={{ fill: 'var(--ink-2)' }}>{out ? 'tope' : pct(Math.min(pv, 1))}</text>
      <line x1={lx} x2={lx} y1={pad.t} y2={H - pad.b} stroke="var(--hanko)" strokeWidth="1.5" />
      {/* One hit area per measurement, from halfway to the one before to halfway to the next. */}
      {w.series.map((p, i) => {
        const a = (xs[i] + xs[i + 1]) / 2, b = i + 2 < xs.length ? (xs[i + 1] + xs[i + 2]) / 2 : xs[i + 1] + 6;
        const text = `${when(p.at)}\nUsado: ${pct(p.used)} de la semana${p.ronin === null ? '' : `\nronin: ${pct(p.ronin)} · otros: ${pct(p.used - p.ronin)}`}`;
        return <g key={p.at} className="mt-hit" {...tip(text)}><rect x={a} y={pad.t} width={Math.max(b - a, 2)} height={H - pad.t - pad.b} fill="transparent" /></g>;
      })}
    </svg>
  );
}

// How each of the last weeks closed, and the one in course at the end.
function WeeksChart({ c }: { c: SubscriptionAccount }) {
  const narrow = isMobile();
  // On the phone, only the day of the month: eight weekdays don't fit.
  const weeks: Array<{ close: number; ronin: number | null; others: number | null; unused: number; label: string; cur: boolean; limitHits?: number; resetsAt?: string }> = c.weeks.map((w) => ({ ...w, label: narrow ? String(new Date(Date.parse(w.resetsAt) - 1).getDate()) : day(Date.parse(w.resetsAt) - 1), cur: false }));
  if (c.week) weeks.push({ close: c.week.used, ronin: c.week.ronin, others: c.week.others, unused: 1 - c.week.used, label: 'esta', cur: true, limitHits: c.week.fiveHour.limitHits });
  const W = narrow ? 360 : 420, H = 210, pad = { l: 34, r: 8, t: 14, b: 26 };
  const cw = (W - pad.l - pad.r) / Math.max(weeks.length, 4), bw = Math.min(cw - 10, 36);
  const y = (v: number) => pad.t + (1 - Math.min(v, 1)) * (H - pad.t - pad.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cómo cerró cada semana de ${c.account}`}>
      {[0, 0.5, 1].map((v) => [
        <line key={`l${v}`} x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--rule)" strokeDasharray={v === 0.5 ? '2 3' : undefined} />,
        <text key={`t${v}`} x={pad.l - 6} y={y(v) + 3} textAnchor="end">{v * 100}%</text>,
      ])}
      {weeks.map((w, i) => {
        const cx = pad.l + i * cw + (cw - bw) / 2;
        const op = w.cur ? '.65' : undefined;
        const text = `${w.cur ? 'Semana en curso' : `Semana que cerró el ${day(Date.parse(w.resetsAt!) - 1)}`}\n${w.cur ? 'Lleva' : 'Cerró en'} ${pct(w.close)}${w.ronin === null ? '' : `: ronin ${pct(w.ronin)} · otros ${pct(w.others!)}`}\n${w.cur ? `Proyección: ${pct(Math.min(c.week!.projection.close, 1))}` : `Sin usar: ${pct(w.unused)}`}${w.limitHits ? `\nTopó el límite ${w.limitHits} ${w.limitHits === 1 ? 'vez' : 'veces'}` : ''}`;
        return [
          <g key={`g${i}`} className="mt-hit" {...tip(text)}>
            <rect x={cx - 4} y={pad.t} width={bw + 8} height={H - pad.t - pad.b} fill="transparent" />
            <rect x={cx} y={y(1)} width={bw} height={y(0) - y(1)} rx="4" fill="var(--raise)" />
            {w.ronin === null
              ? <rect x={cx} y={y(w.close)} width={bw} height={y(0) - y(w.close)} fill={ALL} opacity={op} />
              : <><rect x={cx} y={y(w.ronin)} width={bw} height={y(0) - y(w.ronin)} fill={RONIN} opacity={op} /><rect x={cx} y={y(w.close)} width={bw} height={Math.max(0, y(w.ronin) - y(w.close) - 2)} fill={OTHERS} opacity={op} /></>}
            {i >= weeks.length - 2 ? <text x={cx + bw / 2} y={y(w.close) - 4} textAnchor="middle" className="mt-v">{pct(w.close)}</text> : null}
          </g>,
          <text key={`x${i}`} x={cx + bw / 2} y={H - 8} textAnchor="middle">{w.label}</text>,
        ];
      })}
    </svg>
  );
}

function Account({ c, now }: { c: SubscriptionAccount; now: number }) {
  const shell = useShell();
  const w = c.week;
  const tile = (label: string, value: ReactNode, detail: ReactNode, extra: ReactNode = null) => (
    <div className="tile"><div className="l">{label}</div><div className="v">{value}</div><div className="d">{detail}</div>{extra}</div>
  );
  const split = w && w.ronin !== null
    ? <><div className="su-split" aria-hidden="true"><i style={{ width: `${w.ronin * 100}%`, background: RONIN }} /><i style={{ width: `${w.others! * 100}%`, background: OTHERS }} /></div><div className="su-key"><span><i style={{ background: RONIN }} />ronin {pct(w.ronin)}</span><span><i style={{ background: OTHERS }} />otros {pct(w.others!)}</span></div></>
    : null;
  const exhausts = w?.projection.exhaustsAt && Date.parse(w.projection.exhaustsAt) < Date.parse(w.resetsAt);
  const v = c.value;
  const legend = w?.ronin === null || (!w && c.weeks.every((x) => x.ronin === null))
    ? <span><i style={{ background: ALL }} />Toda la cuenta</span>
    : <><span><i style={{ background: RONIN }} />ronin (estimado)</span><span><i style={{ background: OTHERS }} />Otros usos de la cuenta</span></>;
  const s = c.spend;
  const total = s.byTask.reduce((sum, x) => sum + x.usd, 0);
  const max = Math.max(...s.byTask.map((x) => x.usd), 0.01);
  const rest = s.byTask.slice(7).reduce((sum, x) => sum + x.usd, 0);
  const bars: Array<[string, number]> = [...s.byTask.slice(0, 7).map((x): [string, number] => [typeName(x.key), x.usd]), ...(rest ? [['Otras', rest] as [string, number]] : [])];
  const r = c.perResult;
  const fact = (label: string, x: { avgUsd: number | null; count: number }, unit: string) => (
    <div className="mt-fact"><div className="l">{label}</div><div className="v">{money(x.avgUsd)}</div><div className="mt-sub">{x.count ? `${x.count} ${unit}` : 'ninguno con corridas de ronin'}</div></div>
  );
  return (
    <section className="su-acc">
      <div className="su-h"><h2>{c.account}</h2><span className="su-plan">Plan <b>{c.plan.name}</b>{c.plan.source === 'defecto' ? ' (por defecto)' : ''} · {c.plan.priceUsd === null ? 'sin precio' : `${money(c.plan.priceUsd)} al mes`}{c.repos.length ? ` · ${c.repos.join(', ')}` : ''}</span><button className="link" onClick={() => shell.openSettings('cuentas')}>Cambiar el plan</button></div>
      <div className="tiles su-tiles">
        {w ? tile('Esta semana', pct(w.used), <>se reinicia en <b>{left(Date.parse(w.resetsAt) - now)}</b>{w.ronin === null ? ' · sin estimado de ronin todavía' : ''}</>, split) : tile('Esta semana', '—', 'Sin mediciones esta semana: ronin no corrió con esta cuenta.')}
        {!w ? tile('Proyección', '—', '') : exhausts ? tile('Proyección', <span className="mt-warn">se agota</span>, `el ${when(w.projection.exhaustsAt!)}, a este ritmo`) : tile('Proyección', pct(Math.min(w.projection.close, 1)), <>al reiniciarse, a este ritmo · <b>{pct(Math.max(0, 1 - w.projection.close))}</b> sin usar</>)}
        {c.utilization ? tile('Aprovechamiento', pct(c.utilization.average), `de la cuota semanal, promedio de ${c.utilization.weeks === 1 ? 'la última semana' : `las últimas ${c.utilization.weeks} semanas`}`) : tile('Aprovechamiento', '—', w ? `Aparece cuando cierre la primera semana medida, el ${day(Date.parse(w.resetsAt))}.` : 'Aparece cuando cierre la primera semana medida.')}
        {w ? tile('Ventanas de 5 h', <>{w.fiveHour.over90}<small>de {w.fiveHour.windows}</small></>, <>pasaron del 90 % esta semana · {w.fiveHour.limitHits ? <><b>{w.fiveHour.limitHits}</b> {w.fiveHour.limitHits === 1 ? 'tope' : 'topes'}</> : 'ningún tope'}</>) : tile('Ventanas de 5 h', '—', '')}
        {tile('Rinde', v.ratio === null ? '—' : `${num(v.ratio, v.ratio < 1 ? 2 : 1)}×`, v.ratio === null ? 'Falta el precio del plan.' : `${money(v.equivUsd)} en API por ${money(v.priceUsd)} de plan, últimos ${v.days} días (solo ronin)`)}
      </div>
      <div className="mt-g2 su-g">
        {w ? (
          <section className="pd-card mt-card"><h3>Esta semana <span className="m">uso acumulado de la cuota semanal</span></h3>
            <div className="mt-legend">{legend}<span><i className="ln" style={{ background: 'var(--ink-2)' }} />Proyección</span><span><i style={{ background: 'var(--hanko)', width: '2px' }} />Última medición</span></div>
            <div className="mt-chart"><WeekChart c={c} /></div>
            <Table head={['Medición', 'Usado', 'ronin', 'Otros']} rows={[...w.series].reverse().map((p) => [when(p.at), pct(p.used), p.ronin === null ? '—' : pct(p.ronin), p.ronin === null ? '—' : pct(p.used - p.ronin)])} /></section>
        ) : <section className="pd-card mt-card"><h3>Esta semana</h3><p className="m">Sin mediciones esta semana.</p></section>}
        <section className="pd-card mt-card"><h3>Cómo cerró cada semana <span className="m">% de la cuota usado al reiniciarse</span></h3>
          {c.weeks.length || w ? <>
            <div className="mt-legend">{legend}<span><i style={{ background: 'var(--raise)', boxShadow: 'inset 0 0 0 1px var(--rule)' }} />Sin usar</span></div><div className="mt-chart"><WeeksChart c={c} /></div>
            <Table head={['Semana', 'Cierre', 'ronin', 'Otros', 'Sin usar']} rows={[...c.weeks].reverse().map((x) => [day(Date.parse(x.resetsAt) - 1), pct(x.close), x.ronin === null ? '—' : pct(x.ronin), x.others === null ? '—' : pct(x.others), pct(x.unused)])} />
          </> : null}
          {c.weeks.length ? null : <p className="mt-sub">Todavía no cerró ninguna semana medida: el historial empezó a guardarse con #233.</p>}</section>
      </div>
      <div className="mt-g2 su-g">
        <section className="pd-card mt-card"><h3>En qué se va lo de ronin <span className="m">equivalente en API, últimos {s.days} días</span></h3>
          {bars.length ? bars.map(([name, usd]) => (
            <div key={name} className="mt-hbar"><span className="t">{name}</span><span className="b"><i style={{ width: `${(usd / max) * 100}%`, background: RONIN }} /></span><span className="n">{money(usd)} · {Math.round((usd / (total || 1)) * 100)}%</span></div>
          )) : <p className="m">ronin no corrió con esta cuenta en este tiempo.</p>}
          {s.byRepo.length > 1 ? <div className="mt-sub" style={{ marginTop: '12px' }}>Por repo: {s.byRepo.map((x, i) => <span key={x.key}>{i ? ' · ' : ''}{x.key} <b>{money(x.usd)}</b></span>)}</div> : null}
          {s.byTask.length ? <Table head={['Tarea', 'Equivalente en API', 'Corridas', 'Parte']} rows={s.byTask.map((x) => [typeName(x.key), money(x.usd), x.runs, `${Math.round((x.usd / (total || 1)) * 100)}%`])} /> : null}</section>
        <section className="pd-card mt-card"><h3>Cuánto cuesta cada resultado <span className="m">equivalente en API, últimos {r.days} días</span></h3>
          <div className="su-facts">{fact('Por issue resuelto', r.issue, r.issue.count === 1 ? 'issue' : 'issues')}{fact('Por PR mergeado', r.pr, r.pr.count === 1 ? 'PR' : 'PRs')}{fact('Por pedido del portal', r.portal, r.portal.count === 1 ? 'pedido' : 'pedidos')}</div>
          <p className="mt-sub">Suma las corridas del issue, de su PR y de sus reviews, también las que fallaron. Solo cuenta lo que ronin trabajó.</p></section>
      </div>
    </section>
  );
}

export function Subscription() {
  const shell = useShell();
  const now = useNow();
  const [account, setAccount] = useViewState('su.account', '');
  const query = useQuery({ queryKey: ['subscription'], queryFn: () => ok(client.api.metrics.subscription.$get({ query: {} })), refetchInterval: EVERY_MS });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) shell.unauthorized(query.error.message);
  }, [query.error, shell]);
  const data = query.data;
  const error = query.error && !(query.error instanceof ApiError && query.error.status === 401) ? (query.error as Error).message : null;
  const filters = (
    <div className="mt-filters"><select id="su-cuenta" aria-label="Cuenta" value={account} onChange={(e) => setAccount(e.target.value)}><option value="">Todas las cuentas</option>{(data?.accounts ?? []).map((a) => <option key={a} value={a}>{a}</option>)}</select></div>
  );
  const head = <Head tab="suscripcion" lead="Cuánto se aprovecha cada cuenta de Claude: cuánto de la cuota semanal se usa antes de que se reinicie, qué parte es de ronin y en qué se va." filters={filters} />;
  if (!data) return <div className="today mt">{head}{error ? <p className="bad">{error}</p> : <div className="empty">Calculando…</div>}</div>;
  const shown = data.cuentas.filter((c) => !account || c.account === account);
  const last = shown.map((c) => c.lastMeasuredAt).filter((x): x is string => Boolean(x)).sort().at(-1);
  return (
    <div className="today mt">{head}
      <div className="mt-asof">Medido en cada corrida de ronin{last ? ` · la última ${ago(last, now)}` : ' · todavía sin mediciones'} · la parte de ronin es un estimado{query.isFetching ? ' · actualizando…' : ''}{error ? <> · <span className="bad">{error}</span></> : null}</div>
      {shown.length ? shown.map((c) => <Account key={c.account} c={c} now={now} />) : <p className="m">No hay cuentas de Claude en repos.json.</p>}
      <details className="su-how"><summary>Cómo se calcula</summary>
        <p><b>El uso de la cuenta</b> es el que informa Anthropic en cada corrida de ronin: el % usado de la ventana semanal y de la de 5 horas. Cuenta todo lo que se hace con la cuenta, no solo ronin. Entre una corrida y otra no hay mediciones: lo que otros usen en ese rato aparece en la siguiente.</p>
        <p><b>Una semana cerró</b> cuando su ventana se reinició; su cierre es la medición más alta. <b>Aprovechamiento</b> es el promedio de los cierres de las últimas 4. <b>Proyección</b> lleva el ritmo de las últimas 48 horas hasta el reinicio.</p>
        <p><b>La parte de ronin es un estimado.</b> ronin sabe cuánto habría costado cada corrida suya en la API. Cuando solo ronin usa la cuenta, eso dice cuánta cuota mueve cada dólar; si otros la usan a la vez, la cuota sube de más. Se toma lo que mueve un dólar en los intervalos más bajos de las últimas 4 semanas, y lo que sube por encima se asigna a otros usos. Hacen falta varias mediciones para tenerlo.</p>
        <p><b>Rinde</b> compara lo que habrían costado las corridas de ronin en la API con el precio del plan. No cuenta lo que usan otros con la misma cuenta. El plan se elige en Ajustes → Cuentas de Claude.</p>
      </details>
    </div>
  );
}
