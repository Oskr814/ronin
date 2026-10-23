import { useQueryClient } from '@tanstack/react-query';
import { client, ok } from '@apps/dashboard/src/api.js';
import { useShell } from '@apps/dashboard/src/shell/hooks.js';
import { typeName } from '@apps/dashboard/src/lib/runs.js';
import { Fixed, onCommit, Row, Sec, SectionLink, Switch, useChange } from './parts.js';
import { SETTINGS, word, type Page, type Setting, type Task, type Value } from './model.js';

// The sections made of settings (General, Agentes, Exploración, Previews):
// each one's value is the dashboard's, .env's or the default, and saving one
// takes effect right away, without restarting.

function useSetValue() {
  const shell = useShell();
  const queryClient = useQueryClient();
  const change = useChange();
  return (key: string, value: Value | null) => change(async () => {
    if (Number.isNaN(value)) throw new Error('Tiene que ser un número entero.');
    const { setting } = (await ok(client.api.settings.values.$post({ json: { key, value } }))) as { setting: Setting };
    queryClient.setQueryData<Page>(['settings'], (d) => d && { ...d, valores: d.valores.map((s) => (s.key === key ? setting : s)) });
    shell.toast(value === null ? `${SETTINGS[key]?.[0] ?? key}: vuelve al de ${setting.source === 'env' ? '.env' : 'por defecto'} (${word(setting.value)}).` : 'Guardado. Vale desde ahora.');
  });
}

function SettingRow({ s }: { s: Setting }) {
  const save = useSetValue();
  const [label, desc, unit] = SETTINGS[s.key] ?? [s.key, '', ''];
  const from = (source: string) => (source === 'env' ? '.env dice' : 'por defecto');
  const src = s.source === 'tablero'
    ? <><span className="aj-ov">● Cambiado en el tablero</span><span>{from(s.baseSource)} {word(s.base)}</span><button data-ajreset={s.key} onClick={() => save(s.key, null)}>{s.baseSource === 'env' ? 'Volver al de .env' : 'Volver al de por defecto'}</button></>
    : <>{s.source === 'env' ? <span className="aj-env">.env</span> : <span>Por defecto</span>}<code>{s.env}</code></>;
  const ctl = s.type === 'bool' ? <Switch on={s.value as boolean} data-ajkey={s.key} label={label} onToggle={() => save(s.key, !s.value)} />
    : s.type === 'enum' ? (
      <select className="aj-in" data-ajkey={s.key} aria-label={label} defaultValue={String(s.value)} ref={onCommit((el) => save(s.key, el.value))}>
        {[...new Set([...(s.options ?? []), s.value])].map((o) => <option key={String(o)} value={String(o)}>{word(o)}</option>)}
      </select>
    )
      : s.type === 'text' ? <input className="aj-in mono" data-ajkey={s.key} defaultValue={String(s.value)} aria-label={label} ref={onCommit((el) => save(s.key, el.value))} />
        : <><input className="aj-num" type="number" min={s.min} max={s.max} step="1" data-ajkey={s.key} defaultValue={String(s.value)} aria-label={label} ref={onCommit((el) => {
          const value = Number(el.value);
          save(s.key, el.value.trim() === '' || !Number.isFinite(value) ? NaN : value);
        })} /><span className="aj-unit">{unit}</span></>;
  return <Row label={label} desc={desc} ctl={ctl} src={src} />;
}

const settingOf = (d: Page) => (key: string) => <SettingRow key={key} s={d.valores.find((s) => s.key === key)!} />;

export function General({ d }: { d: Page }) {
  const row = settingOf(d);
  return <>
    <h1>General</h1><p className="lead">El tablero y el portal de pedidos. Un cambio vale al momento, sin reiniciar, y queda en el <SectionLink to="registro">Registro</SectionLink>.</p>
    <Sec title="Tablero"><Fixed label="Dirección" value={d.dashboard.url || '—'} env="DASHBOARD_URL" />{row('dashboard.sessionDays')}{row('dashboard.githubTtlSeconds')}</Sec>
    <Sec title="Portal de pedidos" lead={<>Las cuentas del portal están en <SectionLink to="usuarios">Usuarios</SectionLink>, con el rol Usuario.</>}><Fixed label="Dirección" value={d.portal.url || '—'} env="PORTAL_URL" />{row('portal.dailyLimit')}{row('portal.sessionDays')}{row('portal.remindHours')}{row('portal.expireHours')}</Sec>
    <Sec title="Runner"><Fixed label="Runner" value={d.fixed.runnerId} env="RUNNER_ID" /><Fixed label="Cuenta de GitHub de ronin" value={d.fixed.githubLogin} env="RONIN_GITHUB_LOGIN" /></Sec>
  </>;
}

function TaskRow({ t, d }: { t: Task; d: Page }) {
  const shell = useShell();
  const queryClient = useQueryClient();
  const change = useChange();
  const general = (key: string) => word(d.valores.find((s) => s.key === key)!.value);
  const fallback = (value: string | null, def: string | null, kind: string) => (value !== null ? `${word(value)} (.env)` : def ? `${def} (por defecto)` : `General (${general(kind)})`);
  const save = (field: 'model' | 'effort') => onCommit<HTMLSelectElement>((el) => change(async () => {
    const { tareas } = (await ok(client.api.settings.tasks.$post({ json: { task: t.task, [field]: el.value || null } }))) as { tareas: Task[] };
    queryClient.setQueryData<Page>(['settings'], (p) => p && { ...p, tareas });
    shell.toast('Guardado. Vale desde la próxima corrida.');
  }));
  return (
    <tr>
      <td>{typeName(t.task)}<small className="mono">{t.task}</small></td>
      <td><select className="aj-in" data-ajtask={t.task} data-f="model" aria-label={`Modelo de ${t.task}`} defaultValue={['opus', 'sonnet', 'haiku'].includes(t.model) ? t.model : ''} ref={save('model')}><option value="">{fallback(t.envModel, t.defaultModel, 'agent.model')}</option>{['opus', 'sonnet', 'haiku'].map((m) => <option key={m}>{m}</option>)}</select></td>
      <td><select className="aj-in" data-ajtask={t.task} data-f="effort" aria-label={`Esfuerzo de ${t.task}`} defaultValue={['low', 'medium', 'high', 'xhigh', 'max'].includes(t.effort) ? t.effort : ''} ref={save('effort')}><option value="">{fallback(t.envEffort, t.defaultEffort, 'agent.effort')}</option>{['low', 'medium', 'high', 'xhigh', 'max'].map((m) => <option key={m}>{m}</option>)}</select></td>
    </tr>
  );
}

export function Agents({ d }: { d: Page }) {
  const row = settingOf(d);
  return <>
    <h1>Agentes</h1><p className="lead">Las corridas headless de <code>claude -p</code>. Cada tick y cada webhook leen estos valores al empezar: un cambio vale desde la próxima corrida, sin reiniciar.</p>
    <Sec title="Modelo">{row('agent.model')}{row('agent.effort')}{row('agent.reviewWorkerModel')}</Sec>
    <section className="aj-sec"><h2>Por tipo de tarea</h2><p className="aj-d">Gana sobre el de arriba y sobre <code>AGENT_MODEL_&lt;TIPO&gt;</code> de .env. Un repo puede tener los suyos en <SectionLink to="repos">Repos</SectionLink>.</p>
      <div className="aj-card"><table className="aj-tbl aj-tasks"><thead><tr><th>Tarea</th><th>Modelo</th><th>Esfuerzo</th></tr></thead><tbody>{d.tareas.map((t) => <TaskRow key={t.task} t={t} d={d} />)}</tbody></table></div></section>
    <Sec title="Tiempos">{row('agent.taskTimeoutMinutes')}{row('agent.handlerTimeoutMinutes')}</Sec>
    <Sec title="Concurrencia">{row('tick.intervalMinutes')}{row('tick.concurrency')}{row('tick.externalReviewConcurrency')}</Sec>
    <Sec title="Antes de bloquear" lead="Cuántas veces intenta ronin antes de pedir ayuda (docs/BLOCKING.md).">{row('retry.e2e')}{row('retry.e2eHard')}{row('retry.checksPending')}{row('retry.slice')}{row('retry.retarget')}{row('retry.issueError')}</Sec>
  </>;
}

export function Exploration({ d }: { d: Page }) {
  const row = settingOf(d);
  return <>
    <h1>Exploración</h1><p className="lead">La exploración nocturna y <code>/explore</code>. Qué apps se exploran se elige en cada repo, en <SectionLink to="repos">Repos</SectionLink>.</p>
    <Sec title="Noche">{row('explore.timezone')}{row('explore.nightWindow')}{row('explore.functionsPerNight')}</Sec>
    <Sec title="Cada corrida">{row('explore.functionsPerRun')}{row('explore.findingsPerRun')}{row('explore.ideasPerRun')}{row('explore.publishEvidence')}</Sec>
  </>;
}

export function Previews({ d }: { d: Page }) {
  const row = settingOf(d);
  return <>
    <h1>Previews</h1><p className="lead"><code>/preview</code> en un PR levanta la app en la tailnet.</p>
    <Sec title="Previews">{row('preview.prepareData')}{row('preview.ttlMinutes')}{row('preview.maxPerRepo')}
      <Row label="Puertos" desc="Lo único que la política de Tailscale le abre a alguien de afuera: se cambian juntos, por eso no se tocan aquí." ctl={<span className="aj-ro">{d.fixed.previewPortRange}</span>} src={<><span className="aj-env">.env</span><code>PREVIEW_PORT_RANGE</code><span>· se cambia en el servidor</span></>} />
    </Sec>
  </>;
}
