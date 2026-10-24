import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { ApiError, client, ok, type Metrics } from '@apps/dashboard/src/api.js';
import { useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { DAY_MS, Sparkline } from '@apps/dashboard/src/lib/format.js';
import { tip } from '@apps/dashboard/src/lib/tip.js';
import { useViewState } from '@apps/dashboard/src/lib/view-state.js';
import { ago, useNow } from '@ui/time.js';
import { bucketLabel, duration, num, percent } from './format.js';
import { Head } from './Head.js';

// Métricas → Trabajo (#222): how work moves in the repos: what comes in and
// goes out, how long it takes, who carries it and where it gets stuck.
// Admins only. The numbers come computed (domains/metrics/compute.ts); this
// only draws them. "Resolved" is an issue closed as completed, and times are
// calendar days.

const EVERY_MS = 5 * 60_000;
const KIND: Record<string, string> = { bug: 'Bugs', feature: 'Features', otro: 'Otros' };
const AGE_COLOR = ['var(--ok)', 'var(--run)', 'var(--warn)', 'var(--crit)'];

type Person = Metrics['people'][number];
type SortKey = keyof Person & string;

const COLS: Array<[SortKey, string, string?]> = [
  ['login', 'Persona'], ['open', 'Asignados abiertos'], ['resolved', 'Resueltos'], ['resolutionMedian', 'Mediana resolución', 'hide-m'],
  ['merged', 'PRs mergeados', 'hide-m'], ['reviewRounds', 'Rondas de review', 'hide-m'], ['reviews', 'Reviews hechas', 'hide-m'],
  ['reviewWaitMedian', 'Tarda en revisar', 'hide-m'], ['waitingOnThem', 'Esperan su review'],
];

// The change against the previous period, green when it's for the better.
export function Delta({ cur, prev, upIsGood, fmt = String }: { cur: number | null; prev: number | null; upIsGood: boolean; fmt?: (v: number) => string }) {
  if (cur === null || prev === null || cur === undefined || prev === undefined || prev === 0) return <span className="eq">sin comparación</span>;
  const ch = (cur - prev) / prev;
  if (Math.abs(ch) < 0.03) return <><span className="eq">igual</span> que antes ({fmt(prev)})</>;
  return <><span className={ch > 0 === upIsGood ? 'up' : 'down'}>{ch > 0 ? '▲' : '▼'} {Math.round(Math.abs(ch) * 100)}%</span> vs. {fmt(prev)}</>;
}

function Movement({ m }: { m: Metrics }) {
  const rows = m.series;
  const W = 640, H = 190, pad = { l: 28, r: 34, t: 8, b: 20 };
  const max = Math.max(...rows.flatMap((r) => [r.opened, r.resolved]), 1);
  const bl = rows.map((r) => r.backlog);
  const bmax = Math.max(...bl, 1), bmin = Math.min(...bl) * 0.9;
  const cw = (W - pad.l - pad.r) / rows.length, bw = Math.min(14, cw / 3);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const yb = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - bmin) / (bmax - bmin || 1));
  const cx = (i: number) => pad.l + cw * i + cw / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Issues nuevos y resueltos por ${m.days === 7 ? 'día' : 'semana'}`}>
      {[0, 1, 2, 3, 4].map((k) => {
        const v = Math.round((max * k) / 4);
        return [
          <line key={`l${k}`} x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--rule)" strokeDasharray={k ? '2 3' : undefined} />,
          <text key={`t${k}`} x={pad.l - 6} y={y(v) + 3} textAnchor="end">{v}</text>,
        ];
      })}
      {rows.map((r, i) => [
        <g key={`g${i}`} className="mt-hit" {...tip(`${bucketLabel(r, m.days)}: ${r.opened} nuevos, ${r.resolved} resueltos\nbacklog ${r.backlog}`)}>
          <rect x={cx(i) - cw / 2} y={pad.t} width={cw} height={H - pad.t - pad.b} fill="transparent" />
          <rect x={cx(i) - bw - 1} y={y(r.opened)} width={bw} height={y(0) - y(r.opened)} rx="2" fill="var(--faint)" />
          <rect x={cx(i) + 1} y={y(r.resolved)} width={bw} height={y(0) - y(r.resolved)} rx="2" fill="var(--ok)" />
        </g>,
        <text key={`x${i}`} x={cx(i)} y={H - 5} textAnchor="middle">{bucketLabel(r, m.days)}</text>,
      ])}
      <polyline points={rows.map((r, i) => `${cx(i)},${yb(r.backlog)}`).join(' ')} fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinejoin="round" />
      {rows.map((r, i) => <circle key={i} cx={cx(i)} cy={yb(r.backlog)} r="2.6" fill="var(--warn)" />)}
      <text x={W - pad.r + 6} y={yb(bl.at(-1)!) + 3} className="mt-bl">{bl.at(-1)}</text>
    </svg>
  );
}

function Histogram({ ranges }: { ranges: Metrics['resolution']['tramos'] }) {
  const total = ranges.reduce((s, t) => s + t.count, 0);
  const max = Math.max(...ranges.map((t) => t.count), 1), W = 360, H = 150, pb = 20, cw = W / ranges.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cuánto tardan en resolverse">
      {ranges.map((t, k) => {
        const h = ((H - pb - 14) * t.count) / max, x = cw * k + 6;
        const col = k < 2 ? 'var(--ok)' : k < 4 ? 'var(--run)' : 'var(--warn)';
        return [
          <g key={`g${k}`} className="mt-hit" {...tip(`${t.label}: ${t.count} ${t.count === 1 ? 'issue' : 'issues'}${total ? ` (${Math.round((t.count / total) * 100)}%)` : ''}`)}>
            <rect x={x} y={H - pb - h} width={cw - 12} height={Math.max(h, 0.5)} rx="3" fill={col} opacity=".85" />
            <text x={x + (cw - 12) / 2} y={H - pb - h - 4} textAnchor="middle" className="mt-v">{t.count}</text>
          </g>,
          <text key={`x${k}`} x={x + (cw - 12) / 2} y={H - 5} textAnchor="middle">{t.label}</text>,
        ];
      })}
    </svg>
  );
}

export function MiniBars({ values, color }: { values: number[]; color: string }) {
  const W = 220, H = 46, max = Math.max(...values, 1), cw = W / values.length;
  return (
    <svg className="mt-mini" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {values.map((v, i) => <rect key={i} x={i * cw + 2} y={H - 2 - ((H - 6) * v) / max} width={cw - 4} height={Math.max(1, ((H - 6) * v) / max)} rx="2" fill={color} opacity=".85" />)}
    </svg>
  );
}

export const Fact = ({ label, value, small }: { label: string; value: ReactNode; small?: ReactNode }) => (
  <div className="mt-fact"><div className="l">{label}</div><div className="v">{value}{small ? <> <small>{small}</small></> : null}</div></div>
);

function People({ m }: { m: Metrics }) {
  const shell = useShell();
  const now = useNow();
  const [sort, setSort] = useViewState<SortKey>('mt.sort', 'resolved');
  const [dir, setDir] = useViewState('mt.dir', -1);
  const [open, setOpen] = useViewState<string | null>('mt.open', null);
  const value = (p: Person) => (p[sort] as number | null) ?? -1;
  const people = [...m.people].sort((x, y) => (sort === 'login' ? dir * x.login.localeCompare(y.login) : dir * (value(x) - value(y))));
  const maxDone = Math.max(...people.map((p) => p.resolved), 1);
  const toggle = (login: string) => setOpen(open === login ? null : login);
  return (
    <div className="mt-scroll"><table className="mt-ppl">
      <thead><tr>{COLS.map(([k, label, cls]) => (
        <th key={k} className={cls ?? ''} aria-sort={sort === k ? (dir < 0 ? 'descending' : 'ascending') : undefined}>
          <button onClick={() => { setDir(sort === k ? -dir : k === 'login' ? 1 : -1); setSort(k); }}>{label}</button>
        </th>
      ))}</tr></thead>
      <tbody>
        {people.flatMap((p) => {
          const av = p.agent ? <span className="seal mt-av">浪人</span> : /^[\w-]+$/.test(p.login) ? <img className="mt-av" src={`https://avatars.githubusercontent.com/${p.login}?s=44`} alt="" /> : <span className="mt-av" />;
          const isOpen = open === p.login;
          const row = (
            <tr key={p.login} className="mt-p" aria-expanded={isOpen} tabIndex={0}
              onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a')) toggle(p.login); }}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(p.login); } }}>
              <td><span className="mt-who">{av}{p.login}{p.agent ? <> <span className="chip plain">agente</span></> : null}</span></td>
              <td>{p.open}{p.quiet ? <> <span className="mt-warn" title="sin movimiento hace más de 14 días">· {p.quiet} {p.quiet === 1 ? 'quieto' : 'quietos'}</span></> : null}</td>
              <td><span className="mt-cell"><i style={{ width: `${Math.round((p.resolved / maxDone) * 46)}px` }} />{p.resolved}</span></td>
              <td className="hide-m">{duration(p.resolutionMedian)}</td>
              <td className="hide-m">{p.merged}</td>
              <td className="hide-m">{num(p.reviewRounds)}</td>
              <td className="hide-m">{p.reviews ?? '—'}</td>
              <td className="hide-m">{p.agent ? '—' : duration(p.reviewWaitMedian)}</td>
              <td className={(p.waitingOnThem ?? 0) > 2 ? 'mt-warn' : undefined}>{p.waitingOnThem ?? '—'}</td>
            </tr>
          );
          if (!isOpen) return [row];
          return [row, (
            <tr key={`${p.login}-det`} className="mt-det"><td colSpan={COLS.length}><div className="mt-det-g">
              <div><h4>Resueltos por {m.days === 7 ? 'día' : 'semana'}</h4><MiniBars values={p.perBucket} color={p.agent ? 'var(--hanko)' : 'var(--run)'} /></div>
              <div><h4>Abiertos, el más quieto primero</h4><ul className="mt-list">
                {p.openList.length ? p.openList.map((i) => (
                  <li key={`${i.repo}#${i.number}`}><button className="link" onClick={(e) => { e.stopPropagation(); shell.openItem(`${i.repo}#${i.number}`); }}>#{i.number}</button><span className="t">{i.title}</span>
                    <span className={`a${now - Date.parse(i.updatedAt) > 14 * DAY_MS ? ' mt-warn' : ''}`}>{i.blocked ? 'bloqueado · ' : ''}movido {ago(i.updatedAt, now)}</span></li>
                )) : <li className="m">Nada abierto.</li>}
              </ul></div>
            </div></td></tr>
          )];
        })}
        {people.length ? null : <tr><td colSpan={COLS.length} className="m">Nadie tuvo actividad en este período.</td></tr>}
      </tbody>
    </table></div>
  );
}

export function Work() {
  const shell = useShell();
  const session = useSession();
  const now = useNow();
  const [days, setDays] = useViewState<7 | 30 | 90>('mt.days', 30);
  const [repo, setRepo] = useViewState('mt.repo', '');
  const query = useQuery({
    queryKey: ['metrics', days, repo],
    queryFn: () => ok(client.api.metrics.$get({ query: { days: String(days), ...(repo ? { repo } : {}) } })),
    placeholderData: keepPreviousData,
    refetchInterval: EVERY_MS,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) shell.unauthorized(query.error.message);
  }, [query.error, shell]);

  const m = query.isPlaceholderData ? undefined : query.data;
  const repos = query.data?.repos ?? session.repos;
  const where = repo ? repo : repos.length === 1 ? repos[0] : `los ${repos.length} repos`;
  const filters = (
    <div className="mt-filters">
      <div className="mt-seg" role="group" aria-label="Período">{([7, 30, 90] as const).map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d} días</button>)}</div>
      <select id="mt-repo" aria-label="Repo" value={repo} onChange={(e) => setRepo(e.target.value)}><option value="">Todos los repos</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}</select>
    </div>
  );
  const head = <Head tab="trabajo" lead={`Cómo se mueve el trabajo en ${where}: cuánto entra y cuánto sale, cuánto tarda, quién lo lleva y dónde se traba.`} filters={filters} />;
  if (!m) {
    const error = query.error && !(query.error instanceof ApiError && query.error.status === 401) ? (query.error as Error).message : null;
    return <div className="today mt">{head}{error ? <p className="bad">{error}</p> : <div className="empty">{query.data ? 'Calculando…' : 'Leyendo GitHub… La primera vez trae 6 meses de historia y puede tardar unos segundos por repo.'}</div>}</div>;
  }

  const c = m.current, p = m.previous, s = m.series;
  const oldest = m.sources.map((x) => x.syncedAt).filter((x): x is string => Boolean(x)).sort()[0];
  const failed = m.sources.filter((x): x is typeof x & { error: string } => 'error' in x && Boolean(x.error));
  const tile = (label: string, value: ReactNode, unit: string, delta: ReactNode, series: Array<number | null>) => (
    <div className="tile"><div className="l">{label}</div><div className="v">{value}{unit ? <small>{unit}</small> : null}</div><div className="d">{delta}</div>{series.length > 1 ? <Sparkline values={series} /> : null}</div>
  );
  const per = m.days === 7 ? 'día' : 'semana';
  const resolvedN = m.resolution.tramos.reduce((sum, t) => sum + t.count, 0);
  const h = m.health;
  const ages = h.ages.map((a, i) => ({ ...a, color: AGE_COLOR[i] }));
  const d = m.deploys;
  const r = m.ronin;
  const reasonMax = Math.max(...r.blockReasons.map((x) => x.count), 1);
  const itemButton = (repoName: string, number: number) => (
    <button className="link" onClick={(e) => { e.stopPropagation(); shell.openItem(`${repoName}#${number}`); }}>#{number}</button>
  );

  return (
    <div className="today mt">{head}
      <div className="mt-asof">Últimos {m.days} días, comparados con los {m.days} anteriores{oldest ? ` · datos de GitHub de ${ago(oldest, now)}` : ''}{query.isFetching ? ' · actualizando…' : ''}</div>
      {failed.map((x) => <p key={x.repo} className="bad">No se pudo leer {x.repo}: {x.error}. Se muestran los datos anteriores.</p>)}
      <div className="tiles mt-tiles">
        {tile('Issues resueltos', c.resolved, '', <Delta cur={c.resolved} prev={p.resolved} upIsGood />, s.map((x) => x.resolved))}
        {tile('Tiempo de resolución', duration(c.resolutionMedian), 'mediana', <Delta cur={c.resolutionMedian} prev={p.resolutionMedian} upIsGood={false} fmt={duration} />, s.map((x) => x.resolutionMedian))}
        {tile('Issues nuevos', c.opened, '', <Delta cur={c.opened} prev={p.opened} upIsGood />, s.map((x) => x.opened))}
        {tile('PRs mergeados', c.merged, '', <Delta cur={c.merged} prev={p.merged} upIsGood />, s.map((x) => x.merged))}
        {tile('Hasta la primera review', duration(c.firstReviewMedian), 'mediana', <Delta cur={c.firstReviewMedian} prev={p.firstReviewMedian} upIsGood={false} fmt={duration} />, s.map((x) => x.firstReviewMedian))}
        {tile('Backlog abierto', c.backlog, '', <Delta cur={c.backlog} prev={p.backlog} upIsGood={false} />, s.map((x) => x.backlog))}
      </div>
      <h2 className="mt-sect">Movimiento</h2>
      <div className="mt-g2">
        <section className="pd-card mt-card"><h3>Entra y sale <span className="m">por {per}</span></h3>
          <div className="mt-legend"><span><i style={{ background: 'var(--faint)' }} />Issues nuevos</span><span><i style={{ background: 'var(--ok)' }} />Resueltos</span><span><i className="ln" />Backlog abierto</span></div>
          <div className="mt-chart"><Movement m={m} /></div></section>
        <section className="pd-card mt-card"><h3>Cuánto tarda en resolverse <span className="m">{resolvedN} {resolvedN === 1 ? 'issue' : 'issues'}</span></h3>
          <div className="mt-sub">Desde que se abre hasta que se cierra como completado. Mediana <b>{duration(c.resolutionMedian)}</b>{c.resolutionP90 !== null ? <> · 9 de cada 10 en menos de <b>{duration(c.resolutionP90)}</b></> : null}.</div>
          <div className="mt-chart"><Histogram ranges={m.resolution.tramos} /></div>
          {m.resolution.kinds.filter((k) => k.resolved).map((k) => (
            <div key={k.kind} className="mt-hbar"><span className="t">{KIND[k.kind]}</span><span className="b"><i style={{ width: `${resolvedN ? (k.resolved / resolvedN) * 100 : 0}%`, background: 'var(--run)' }} /></span><span className="n">{k.resolved} · {duration(k.median)}</span></div>
          ))}</section>
      </div>
      <h2 className="mt-sect">Por persona</h2>
      <section className="pd-card mt-card"><People m={m} />
        <p className="mt-sub">Cada persona asignada a un issue se lleva el crédito. «Rondas de review»: cuántas veces, en promedio, le pidieron cambios a un PR suyo antes de mergearlo. «Tarda en revisar»: desde que le piden la review hasta que deja la primera. Tocá una fila para ver su semana a semana y lo que tiene abierto.</p></section>
      <h2 className="mt-sect">Salud del flujo</h2>
      <div className="mt-g3">
        <section className="pd-card mt-card"><h3>Antigüedad del backlog <span className="m">{h.open} abiertos</span></h3>
          <div className="mt-stack">{ages.map((a) => <i key={a.label} style={{ width: `${h.open ? (a.count / h.open) * 100 : 0}%`, background: a.color }} />)}</div>
          {ages.map((a) => <div key={a.label} className="mt-hbar mt-key"><span className="t"><i style={{ background: a.color }} />{a.label}</span><span /><span className="n">{a.count}</span></div>)}
          <div className="mt-facts"><Fact label="Sin asignar" value={h.unassigned} /><Fact label="Asignados, quietos hace 30 días" value={h.stale} /><Fact label="Reabiertos" value={h.reopened} small={`de ${c.resolved}`} /><Fact label="Cerrados sin hacer" value={h.notPlanned} /></div></section>
        <section className="pd-card mt-card"><h3>PRs esperando review <span className="m">hace más de 2 días</span></h3>
          <ul className="mt-list">{h.waitingReview.length ? h.waitingReview.map((w) => (
            <li key={`${w.repo}#${w.number}`}>{itemButton(w.repo, w.number)}<span className="t">{w.title}</span><span className={`a${now - Date.parse(w.since) > 5 * DAY_MS ? ' mt-warn' : ''}`}>{ago(w.since, now)} · {w.reviewers.map((x) => `@${x}`).join(', ')}</span></li>
          )) : <li className="m">Ninguno.</li>}</ul>
          {h.waitingReviewTotal > h.waitingReview.length ? <div className="mt-sub">y {h.waitingReviewTotal - h.waitingReview.length} más</div> : null}
          <div className="mt-facts"><Fact label="De PR abierto a merge" value={duration(h.mergeMedian)} small="mediana" /><Fact label="Mergeados sin pedir cambios" value={percent(h.firstTry)} /></div></section>
        <section className="pd-card mt-card"><h3>Despliegues <span className="m">{d ? (d.repos.length === 1 ? d.repos[0] : `${d.repos.length} repos`) : ''}</span></h3>
          {d ? <>
            <div className="mt-big">{d.count} <small>en {m.days} días · {num(d.perWeek)} por semana</small></div><div className="mt-sub"><Delta cur={d.count} prev={d.previous} upIsGood /></div>
            <div className="mt-facts"><Fact label="De merge a producción" value={duration(d.leadMedian)} small="mediana" /></div><MiniBars values={d.perBucket} color="var(--repo-1)" />
          </> : <p className="m">Ningún repo publica releases: sin releases no hay cómo saber cuándo algo llegó a producción.</p>}</section>
      </div>
      <h2 className="mt-sect">ronin</h2>
      <div className="mt-g3">
        <section className="pd-card mt-card"><h3>Parte del trabajo</h3>
          <div className="mt-big">{percent(r.share)} <small>de los issues resueltos</small></div>
          <div className="mt-stack"><i style={{ width: `${(r.share ?? 0) * 100}%`, background: 'var(--hanko)' }} /><i style={{ width: `${r.share === null ? 0 : (1 - r.share) * 100}%`, background: 'var(--run)', opacity: '.6' }} /></div>
          <div className="mt-legend"><span><i style={{ background: 'var(--hanko)' }} />ronin · {r.resolved}</span><span><i style={{ background: 'var(--run)', opacity: '.6' }} />Personas · {r.peopleResolved}</span></div>
          <div className="mt-facts"><Fact label="Resolución, ronin" value={duration(r.resolutionMedian)} /><Fact label="Resolución, personas" value={duration(r.peopleResolutionMedian)} /></div></section>
        <section className="pd-card mt-card"><h3>Sin ayuda</h3>
          <div className="mt-big">{percent(r.unblocked)} <small>terminó sin bloquearse</small></div>
          <div className="mt-facts"><Fact label="PRs aprobados sin cambios" value={percent(r.firstTry)} /><Fact label="Intentos de fix" value={num(r.attempts)} small="por PR" /></div></section>
        <section className="pd-card mt-card"><h3>Por qué se bloqueó <span className="m">{r.blocks} {r.blocks === 1 ? 'vez' : 'veces'}</span></h3>
          {r.blockReasons.length ? r.blockReasons.map((x) => (
            <div key={x.reason} className="mt-hbar"><span className="t" title={x.reason}>{x.reason}</span><span className="b"><i style={{ width: `${(x.count / reasonMax) * 100}%`, background: 'var(--crit)' }} /></span><span className="n">{x.count}</span></div>
          )) : <p className="m">No se bloqueó en este período.</p>}</section>
      </div>
    </div>
  );
}
