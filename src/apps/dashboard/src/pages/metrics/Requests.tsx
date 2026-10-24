import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { ApiError, client, ok, type RequestMetrics as Data } from '@apps/dashboard/src/api.js';
import { useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { Sparkline } from '@apps/dashboard/src/lib/format.js';
import { tip } from '@apps/dashboard/src/lib/tip.js';
import { useViewState } from '@apps/dashboard/src/lib/view-state.js';
import { ago, useNow } from '@ui/time.js';
import { bucketLabel, duration, num, percent } from './format.js';
import { Head } from './Head.js';
import { Delta, Fact } from './Work.js';

// Métricas → Pedidos (#428): how the portal's requests are attended to —
// what comes in and goes out, how long each stretch takes and whose wait it
// is, who of the team takes them, and where they wait. Admins only. The
// numbers come computed (domains/metrics/requests.ts); this only draws them.
// It shares Trabajo's period and repo.

const EVERY_MS = 5 * 60_000;
const WHOSE: Record<string, [string, string]> = {
  ronin: ['ronin', 'var(--hanko)'], persona: ['La persona', 'var(--warn)'], equipo: ['El equipo', 'var(--run)'], entrega: ['Entrega', 'var(--ok)'],
};

function Movement({ m }: { m: Data }) {
  const rows = m.series;
  const W = 640, H = 170, pad = { l: 28, r: 8, t: 8, b: 20 };
  const max = Math.max(...rows.flatMap((r) => [r.opened, r.delivered]), 1);
  const cw = (W - pad.l - pad.r) / rows.length, bw = Math.min(14, cw / 3);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const cx = (i: number) => pad.l + cw * i + cw / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Pedidos nuevos y entregados por ${m.days === 7 ? 'día' : 'semana'}`}>
      {[0, 1, 2, 3, 4].map((k) => {
        const v = Math.round((max * k) / 4);
        return [
          <line key={`l${k}`} x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--rule)" strokeDasharray={k ? '2 3' : undefined} />,
          <text key={`t${k}`} x={pad.l - 6} y={y(v) + 3} textAnchor="end">{v}</text>,
        ];
      })}
      {rows.map((r, i) => [
        <g key={`g${i}`} className="mt-hit" {...tip(`${bucketLabel(r, m.days)}: ${r.opened} nuevos, ${r.delivered} entregados`)}>
          <rect x={cx(i) - cw / 2} y={pad.t} width={cw} height={H - pad.t - pad.b} fill="transparent" />
          <rect x={cx(i) - bw - 1} y={y(r.opened)} width={bw} height={y(0) - y(r.opened)} rx="2" fill="var(--faint)" />
          <rect x={cx(i) + 1} y={y(r.delivered)} width={bw} height={y(0) - y(r.delivered)} rx="2" fill="var(--ok)" />
        </g>,
        <text key={`x${i}`} x={cx(i)} y={H - 5} textAnchor="middle">{bucketLabel(r, m.days)}</text>,
      ])}
    </svg>
  );
}

// Each stretch with its median and its p90. Minutes and weeks share the
// bars, so their length goes by the square root: a short one still shows.
function Times({ m }: { m: Data }) {
  const shown = m.times.filter((x) => x.count);
  const max = Math.sqrt(Math.max(...shown.map((x) => x.p90 ?? 0), 1));
  const w = (v: number | null) => (Math.sqrt(v ?? 0) / max) * 100;
  if (!shown.length) return <p className="m">Ningún pedido avanzó en este período.</p>;
  return <>{shown.map((x) => (
    <div key={x.key} className="mt-hbar mt-tramo" {...tip(`${x.label}: ${x.count} ${x.count === 1 ? 'pedido' : 'pedidos'}\nmediana ${duration(x.median)} · 9 de cada 10 en menos de ${duration(x.p90)}`)}>
      <span className="t"><i style={{ background: WHOSE[x.whose][1] }} />{x.label}</span>
      <span className="b"><i style={{ width: `${w(x.median)}%`, background: WHOSE[x.whose][1] }} /><i className="p90" style={{ width: `${w(x.p90) - w(x.median)}%`, background: WHOSE[x.whose][1] }} /></span>
      <span className="n">{duration(x.median)} · {duration(x.p90)}</span>
    </div>
  ))}</>;
}

function Table({ head, rows, empty }: { head: Array<[string, string?]>; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="mt-scroll"><table className="mt-ppl mt-plain">
      <thead><tr>{head.map(([label, cls]) => <th key={label} className={cls ?? ''}>{label}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((r, i) => <tr key={i}>{r.map((c, k) => <td key={k} className={head[k][1] ?? ''}>{c}</td>)}</tr>) : <tr><td colSpan={head.length} className="m">{empty}</td></tr>}</tbody>
    </table></div>
  );
}

export function RequestMetrics() {
  const shell = useShell();
  const session = useSession();
  const now = useNow();
  const [days, setDays] = useViewState<7 | 30 | 90>('mt.days', 30);
  const [repo, setRepo] = useViewState('mt.repo', '');
  const query = useQuery({
    queryKey: ['metrics-requests', days, repo],
    queryFn: () => ok(client.api.metrics.requests.$get({ query: { days: String(days), ...(repo ? { repo } : {}) } })),
    placeholderData: keepPreviousData,
    refetchInterval: EVERY_MS,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) shell.unauthorized(query.error.message);
  }, [query.error, shell]);

  const m = query.isPlaceholderData ? undefined : query.data;
  const repos = query.data?.repos ?? session.repos;
  const filters = (
    <div className="mt-filters">
      <div className="mt-seg" role="group" aria-label="Período">{([7, 30, 90] as const).map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d} días</button>)}</div>
      <select aria-label="Repo" value={repo} onChange={(e) => setRepo(e.target.value)}><option value="">Todos los repos</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}</select>
    </div>
  );
  const head = <Head tab="pedidos" lead="Cómo se atienden los pedidos del portal: cuántos entran y se entregan, cuánto tarda cada tramo y de quién es la espera, quién del equipo los toma y dónde esperan." filters={filters} />;
  if (!m) {
    const error = query.error && !(query.error instanceof ApiError && query.error.status === 401) ? (query.error as Error).message : null;
    return <div className="today mt">{head}{error ? <p className="bad">{error}</p> : <div className="empty">Calculando…</div>}</div>;
  }

  const c = m.current, p = m.previous, s = m.series, q = m.quality, pr = m.priority, h = m.health;
  const per = m.days === 7 ? 'día' : 'semana';
  const tile = (label: string, value: ReactNode, unit: string, delta: ReactNode, series: Array<number | null>) => (
    <div className="tile"><div className="l">{label}</div><div className="v">{value}{unit ? <small>{unit}</small> : null}</div><div className="d">{delta}</div>{series.length > 1 ? <Sparkline values={series} /> : null}</div>
  );
  const open = (n: number) => (e: { stopPropagation: () => void }) => { e.stopPropagation(); shell.openRequest(n); };
  const list = (items: typeof h.slowDev, total: number, empty: string) => <>
    <ul className="mt-list">{items.length ? items.map((x) => (
      <li key={x.number}><button className="link" onClick={open(x.number)}>P-{x.number}</button><span className="t">{x.prioritized ? <span className="pd-tag prio">Prioritario</span> : null} {x.title}</span><span className="a">{x.person} · {ago(x.since, now)}</span></li>
    )) : <li className="m">{empty}</li>}</ul>
    {total > items.length ? <div className="mt-sub">y {total - items.length} más</div> : null}
  </>;

  return (
    <div className="today mt">{head}
      <div className="mt-asof">Últimos {m.days} días, comparados con los {m.days} anteriores{query.isFetching ? ' · actualizando…' : ''}</div>
      <div className="tiles mt-tiles">
        {tile('Pedidos nuevos', c.opened, '', <Delta cur={c.opened} prev={p.opened} upIsGood />, s.map((x) => x.opened))}
        {tile('Entregados', c.delivered, '', <Delta cur={c.delivered} prev={p.delivered} upIsGood />, s.map((x) => x.delivered))}
        {tile('Hasta entregarse', duration(c.deliverMedian), 'mediana', <Delta cur={c.deliverMedian} prev={p.deliverMedian} upIsGood={false} fmt={duration} />, s.map((x) => x.deliverMedian))}
        {tile('Esperan al equipo', m.waiting.dev + m.waiting.big, 'ahora', <>{m.waiting.dev} a un dev · {m.waiting.big} grandes</>, [])}
        {tile('Respondidos por ronin', percent(c.answeredShare), '', <>de {c.ended} que terminaron</>, [])}
        {tile('Cancelados o vencidos', percent(c.droppedShare), '', <Delta cur={c.droppedShare} prev={p.droppedShare} upIsGood={false} fmt={percent} />, [])}
      </div>

      <h2 className="mt-sect">Movimiento</h2>
      <div className="mt-g2">
        <section className="pd-card mt-card"><h3>Entran y se entregan <span className="m">por {per}</span></h3>
          <div className="mt-legend"><span><i style={{ background: 'var(--faint)' }} />Nuevos</span><span><i style={{ background: 'var(--ok)' }} />Entregados</span></div>
          <div className="mt-chart"><Movement m={m} /></div>
          <div className="mt-sub">Entregado: su PR se mergeó o el equipo lo resolvió. Desde que entra, mediana <b>{duration(c.deliverMedian)}</b>{c.deliverP90 !== null ? <> · 9 de cada 10 en menos de <b>{duration(c.deliverP90)}</b></> : null}.</div></section>
        <section className="pd-card mt-card"><h3>Cuánto tarda cada tramo <span className="m">mediana · p90</span></h3>
          <div className="mt-legend">{Object.values(WHOSE).map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}</div>
          <Times m={m} />
          <div className="mt-sub">Cada tramo cuenta de quién es la espera. La barra llena es la mediana; la clara, hasta el p90.</div></section>
      </div>

      <h2 className="mt-sect">Por persona del equipo</h2>
      <section className="pd-card mt-card">
        <Table head={[['Persona'], ['Decisiones'], ['Tarda en decidir'], ['Grandes abiertos'], ['El más viejo', 'hide-m'], ['Grandes cerrados', 'hide-m'], ['Mediana', 'hide-m'], ['Mensajes', 'hide-m'], ['Prioridad quitada', 'hide-m']]}
          rows={m.team.map((x) => [
            <span className="mt-who">{/^[\w-]+$/.test(x.login) ? <img className="mt-av" src={`https://avatars.githubusercontent.com/${x.login}?s=44`} alt="" /> : <span className="mt-av" />}{x.login}</span>,
            <span title={`${x.deploy} desplegar · ${x.review} con revisión · ${x.decline} no hacer`}>{x.decisions}</span>,
            duration(x.decideMedian), x.bigOpen, duration(x.bigOldest), x.bigClosed, duration(x.bigMedian), x.messages, x.unprioritized,
          ])}
          empty="Nadie del equipo atendió pedidos en este período." />
        <p className="mt-sub">«Decisiones»: las que tomó un dev antes de que ronin hiciera el cambio; «Tarda en decidir», desde que el pedido lo espera. Un pedido grande es de quien está asignado a su issue en GitHub. «Mensajes»: los que le escribió a quien pidió.</p></section>

      <h2 className="mt-sect">Por cuenta del portal</h2>
      <section className="pd-card mt-card">
        <Table head={[['Cuenta'], ['Pedidos'], ['Entregados'], ['Prioritarios'], ['Prioridad quitada'], ['Cancelados o vencidos', 'hide-m']]}
          rows={m.accounts.map((x) => [<span className="mt-who">{x.name}</span>, x.opened, x.delivered, x.prioritized, <span className={x.unprioritized ? 'mt-warn' : undefined}>{x.unprioritized}</span>, x.dropped])}
          empty="Nadie pidió nada en este período." />
        <p className="mt-sub">Una cuenta a la que el equipo le quita la prioridad seguido marca de más: se le puede bajar el tope en Ajustes.</p></section>

      <h2 className="mt-sect">Resultados</h2>
      <div className="mt-g3">
        <section className="pd-card mt-card"><h3>Prioritarios <span className="m">{pr.marked} marcados</span></h3>
          <div className="mt-facts"><Fact label="El equipo les quitó la prioridad" value={pr.removed} small={pr.marked ? `de ${pr.marked}` : undefined} />
            <Fact label="Un dev decide un prioritario" value={duration(pr.decideMedian)} small="mediana" /><Fact label="Uno normal" value={duration(pr.normalDecideMedian)} small="mediana" /></div></section>
        <section className="pd-card mt-card"><h3>Calidad</h3>
          <div className="mt-facts">
            <Fact label="Propuestas que no le sirvieron" value={percent(q.rejectedShare)} small={q.proposalsDecided ? `de ${q.proposalsDecided}` : undefined} />
            <Fact label="Propuestas por pedido" value={num(q.proposalsPerRequest)} />
            <Fact label="No se hicieron, por un dev" value={percent(q.declinedShare)} small={q.devDecided ? `de ${q.devDecided}` : undefined} />
            <Fact label="Errores reproducidos" value={percent(q.reproducedShare)} small={q.bugs ? `de ${q.bugs}` : undefined} />
            <Fact label="Despliegues fallidos" value={q.deploysFailed} small={q.deploys ? `de ${q.deploys}` : undefined} />
          </div></section>
        <section className="pd-card mt-card"><h3>Por app</h3>
          {m.apps.length ? m.apps.map((x) => (
            <div key={`${x.repo}:${x.app}`} className="mt-hbar"><span className="t" title={x.repo}>{x.app}</span><span className="b"><i style={{ width: `${(x.opened / Math.max(...m.apps.map((y) => y.opened), 1)) * 100}%`, background: 'var(--run)' }} /></span><span className="n">{x.opened} · {x.delivered} · {duration(x.deliverMedian)}</span></div>
          )) : <p className="m">Ningún pedido en este período.</p>}
          <div className="mt-sub">Nuevos · entregados · mediana hasta entregarse.</div></section>
      </div>

      <h2 className="mt-sect">Dónde esperan</h2>
      <div className="mt-g3">
        <section className="pd-card mt-card"><h3>Esperan a un dev <span className="m">hace más de 24 h</span></h3>{list(h.slowDev, h.slowDevTotal, 'Ninguno.')}</section>
        <section className="pd-card mt-card"><h3>Grandes sin dueño <span className="m">su issue sin asignar</span></h3>{list(h.unowned, h.unownedTotal, 'Ninguno.')}</section>
        <section className="pd-card mt-card"><h3>La persona respondió <span className="m">y nadie la leyó</span></h3>{list(h.unanswered, h.unansweredTotal, 'Ninguno.')}</section>
      </div>
    </div>
  );
}
