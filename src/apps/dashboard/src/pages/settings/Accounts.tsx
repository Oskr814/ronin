import { useQueryClient } from '@tanstack/react-query';
import { client, ok } from '../../api.js';
import { useHost } from '../../host.js';
import { pct } from '../../lib/format.js';
import { ago } from '../../../../../ui/time.js';
import { onCommit, Row, Sec, useChange } from './parts.js';
import type { Account, Accounts as AccountsData, UsageWindow } from './model.js';
import type { Data } from './Settings.js';

// Cuentas de Claude (#234): the plan each account pays, for Métricas →
// Suscripción.

const usd = (n: number | null) => (n === null ? '—' : `$${n}`);

export function Accounts({ data }: { data: Data }) {
  const d = data.accounts;
  if (!d) return <><h1>Cuentas de Claude</h1><div className="empty">Cargando…</div></>;
  const def = d.plans.find((p) => p.id === 'max5')!;
  return <>
    <h1>Cuentas de Claude</h1><p className="lead">Las cuentas con las que corre ronin, una por <code>claudeConfigDir</code> de <code>repos.json</code>. El plan sirve para calcular en Métricas cuánto rinde cada una. Una cuenta sin elegir cuenta como {def.name} ({usd(def.priceUsd)}).</p>
    {d.cuentas.length ? d.cuentas.map((c) => <Card key={c.account} c={c} d={d} />) : <div className="aj-card"><div className="aj-row"><span className="m">Ningún repo tiene cuenta todavía.</span></div></div>}
  </>;
}

function Card({ c, d }: { c: Account; d: AccountsData }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const change = useChange();
  const a = c.account;
  const p = c.plan;
  const def = d.plans.find((x) => x.id === 'max5')!;
  const list = d.plans.find((x) => x.id === p.plan)?.priceUsd ?? null;
  const save = (body: { plan?: string | null; priceUsd?: number | null }) => change(async () => {
    if (Number.isNaN(body.priceUsd)) throw new Error('El precio tiene que ser un número.');
    const { cuenta } = (await ok(client.api.settings.accounts[':account'].$post({ param: { account: a }, json: body }))) as { cuenta: Account };
    queryClient.setQueryData<AccountsData>(['settings', 'accounts'], (x) => x && { ...x, cuentas: x.cuentas.map((y) => (y.account === a ? cuenta : y)) });
    host.toast(`Guardado: ${a} en ${cuenta.plan.name}${cuenta.plan.priceUsd === null ? '' : `, $${cuenta.plan.priceUsd} al mes`}.`);
  });
  const planSrc = p.source === 'tablero'
    ? <><span className="aj-ov">● Cambiado en el tablero</span><button data-ajplanreset={a} onClick={() => save({ plan: null })}>Volver al de por defecto ({def.name})</button></>
    : <span>Por defecto: {def.name}</span>;
  const priceSrc = list === null ? <span>{p.name} no tiene precio de lista: pon lo que pagan al mes.</span>
    : p.priceUsd === list ? <span>El de lista de {p.name}</span> : <><span>El de lista de {p.name} es {usd(list)}</span><button data-ajprice={a} data-v="" onClick={() => save({ priceUsd: null })}>Usar {usd(list)}</button></>;
  const u = c.usage;
  const fresh = (w: UsageWindow | undefined): w is UsageWindow => Boolean(w && Date.parse(w.resetsAt) > Date.now());
  const now = !u ? <span className="m">Sin uso registrado</span>
    : <>{fresh(u.sevenDay) ? <><b>{pct(u.sevenDay.utilization)}</b> de la semana</> : 'La semana se reinició'} · {fresh(u.fiveHour) ? `${pct(u.fiveHour.utilization)} de la ventana de 5 h` : 'ventana de 5 h libre'}</>;
  return (
    <section className="aj-sec"><h2>{a}</h2><p className="aj-d">{c.repos.length ? c.repos.join(', ') : 'Ningún repo la usa ahora; tiene uso registrado.'}</p><div className="aj-card">
      <Row label="Plan" ctl={
        <select className="aj-in" data-ajplan={a} aria-label={`Plan de ${a}`} defaultValue={p.plan} ref={onCommit((el) => save({ plan: el.value }))}>
          {d.plans.map((x) => <option key={x.id} value={x.id}>{x.name}{x.priceUsd === null ? '' : ` · $${x.priceUsd}`}</option>)}
        </select>
      } src={planSrc} />
      <Row label="Precio al mes" desc="En dólares. Se completa con el del plan." ctl={<><span className="aj-unit pre">$</span><input className="aj-num" type="number" min="0" step="1" data-ajprice={a} defaultValue={p.priceUsd ?? ''} placeholder="—" aria-label={`Precio al mes de ${a}`} ref={onCommit((el) => {
        const value = Number(el.value);
        save({ priceUsd: el.value.trim() === '' ? null : Number.isFinite(value) ? value : NaN });
      })} /><span className="aj-unit">al mes</span></>} src={priceSrc} />
      <Row label="Uso ahora" desc={u ? `Lo que dijo la última corrida de ronin, ${ago(u.measuredAt)}. Cuenta todo lo que usa la cuenta, no solo ronin.` : 'Aparece con la primera corrida de ronin en esta cuenta.'} ctl={<span>{now}</span>} />
      <Row label="Configuración" ctl={<span className="aj-ro">{c.claudeConfigDir || '~/.claude (la de Claude Code por defecto)'}</span>} src={<><span className="aj-env">repos.json</span><code>claudeConfigDir</code><span>· se cambia en el archivo</span></>} />
    </div></section>
  );
}
