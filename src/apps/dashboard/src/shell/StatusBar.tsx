import { hhmm, pct } from '../lib/format.js';
import { short } from '@ui/time.js';
import { changed, logout, MINUTE, repoShort, S } from './state.js';

// The status bar: each Claude account's quota, the runner's machine, the
// agents, the queue, the previews, GitHub, the tick, who's in, the theme.

type Usage = NonNullable<typeof S.snap>['usage'][number];
type HostLoad = NonNullable<NonNullable<typeof S.snap>['runner']['host']>;

function UsageMeter({ usage }: { usage: Usage }) {
  const now = Date.now();
  const out = Boolean(usage.limitHitAt && usage.fiveHour && Date.parse(usage.fiveHour.resetsAt) > now);
  const fresh = (window: { resetsAt: string } | null | undefined) => window && Date.parse(window.resetsAt) > now;
  const five = fresh(usage.fiveHour) ? usage.fiveHour!.utilization : null;
  const week = fresh(usage.sevenDay) ? usage.sevenDay!.utilization : null;
  const title = `Cuenta ${usage.account}, medido hace ${short(now - Date.parse(usage.measuredAt))}` +
    (usage.fiveHour ? `. La ventana de 5 h se reinicia a las ${hhmm(usage.fiveHour.resetsAt)}` : '') +
    (usage.sevenDay ? `, la semanal el ${new Date(usage.sevenDay.resetsAt).toLocaleDateString('es', { weekday: 'long' })}` : '');
  const value = out ? `sin cuota hasta ${hhmm(usage.fiveHour!.resetsAt)}` : five === null ? 'se reinició' : `${pct(five)} 5h`;
  return <span className={`meter${out ? ' out' : ''}`} title={title}>{usage.account}<span className="m"><span className={five !== null && five >= 0.75 ? 'hot' : ''} style={{ width: `${five === null ? 0 : Math.min(100, five * 100)}%` }} /></span><b>{value}</b>{week !== null ? <span className="hide-m">{pct(week)} sem</span> : null}</span>;
}

// A repo whose API fallback (#421) is near its cap, or at it: only shown then.
type ApiBudget = NonNullable<typeof S.snap>['apiBudgets'][number];
function ApiMeter({ budget }: { budget: ApiBudget }) {
  const used = budget.maxUsd ? budget.spentUsd / budget.maxUsd : 1;
  const title = `Respaldo por API de ${budget.repo}: gastó $${budget.spentUsd.toFixed(2)} de $${budget.maxUsd.toFixed(2)}.` +
    (budget.out ? ' Ya no termina corridas cortadas por la cuota: recarga los créditos y reinícialo en Ajustes → Cuentas de Claude.' : '');
  return <span className={`meter ${budget.out ? 'out' : 'hot'}`} title={title}>API {repoShort(budget.repo)}<span className="m"><span className="hot" style={{ width: `${Math.min(100, used * 100)}%` }} /></span><b>{budget.out ? 'sin saldo' : pct(used)}</b></span>;
}

// The runner's machine: CPU and memory in use, hot from 85%.
const HOST_HOT = 0.85;
function HostMeter({ host }: { host: HostLoad | null | undefined }) {
  if (!host) return null;
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  const bar = (label: string, value: number) => <span className={`meter${value >= HOST_HOT ? ' hot' : ''}`}>{label}<span className="m"><span className={value >= HOST_HOT ? 'hot' : ''} style={{ width: `${Math.min(100, value * 100)}%` }} /></span><b>{pct(value)}</b></span>;
  const title = `Runner: CPU ${pct(host.cpu)} de ${host.cores} núcleos (carga ${host.load.join(' / ')}), memoria ${gb(host.memUsedBytes)} de ${gb(host.memTotalBytes)}`;
  return <span className="host hide-m" title={title}>{bar('cpu', host.cpu)}{bar('ram', host.ram)}</span>;
}

export function StatusBar() {
  const snap = S.snap!;
  const { slots, queue, tick } = snap.runner;
  const tickAge = tick.lastTickAt ? Date.now() - Date.parse(tick.lastTickAt) : null;
  const dark = document.documentElement.dataset.theme !== 'light';
  const theme = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ronin-theme', next); } catch { /* sin storage */ }
    changed();
  };
  const badGithub = snap.github.filter((g) => g.error);
  return (
    <footer className="bar-s" id="statusbar">
      {snap.usage.map((usage) => <UsageMeter key={usage.account} usage={usage} />)}
      {(snap.apiBudgets ?? []).map((budget) => <ApiMeter key={budget.repo} budget={budget} />)}
      <HostMeter host={snap.runner.host} />
      <span className="sp hide-m" title={(slots.repos ?? []).map((r) => `${repoShort(r.repo)}: ${r.used} de ${r.limit}`).join(', ')}>agentes {slots.used}/{slots.limit}</span>
      <span className="hide-m">en cola {queue.length}</span>
      <span className="hide-m">previews {snap.previews.length}</span>
      {badGithub.length ? <span className="hide-m bad" title={badGithub.map((g) => `${g.repo}: ${g.error}`).join('; ')}>GitHub sin responder</span> : null}
      <span className="hide-m"><span className={`ok-dot${tickAge === null || tickAge > 45 * MINUTE ? ' stale' : ''}`} />{tickAge === null ? 'sin tick hoy' : `tick hace ${short(tickAge)}`}</span>
      <span className="hide-m">{snap.me}</span>
      <button id="theme" onClick={theme}>{dark ? 'Tema claro' : 'Tema oscuro'}</button><button id="logout" onClick={() => void logout()}>Salir</button>
    </footer>
  );
}
