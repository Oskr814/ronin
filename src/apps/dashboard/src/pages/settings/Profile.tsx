import { useQueryClient } from '@tanstack/react-query';
import { client, ok } from '@apps/dashboard/src/api.js';
import { setTheme, useRepoColor, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { onCommit, Row, Sec, SectionLink, Switch, useChange } from './parts.js';
import { EVENTS, type Notifications as NotificationsData, type Page } from './model.js';

// Tu cuenta: everyone's own, admin or not.

export function Profile({ d }: { d: Page }) {
  const shell = useShell();
  const queryClient = useQueryClient();
  const change = useChange();
  const p = d.perfil;
  const dark = document.documentElement.dataset.theme !== 'light';
  const save = (patch: Record<string, unknown>) => change(async () => {
    const { perfil } = (await ok(client.api.settings.profile.$post({ json: patch }))) as { perfil: Page['perfil'] };
    queryClient.setQueryData<Page>(['settings'], (x) => x && { ...x, perfil });
    shell.toast('Guardado.');
  });
  const theme = (t: 'dark' | 'light') => change(async () => setTheme(t));
  return <>
    <h1>Perfil</h1><p className="lead">Cómo te ve ronin. Tu usuario viene de GitHub.</p>
    <Sec title="Tú">
      <Row label={<span className="aj-me">{d.me.login}</span>} desc="GitHub" ctl={<span className={`aj-pill${d.me.admin ? ' admin' : ''}`}>{d.me.admin ? 'Administrador' : 'Miembro'}</span>} />
      <Row label="Nombre" desc="Con el que apareces en los correos y en lo que ronin propone." ctl={<input className="aj-in" maxLength={120} data-ajme="name" defaultValue={p.name ?? ''} placeholder={d.me.login} aria-label="Nombre" ref={onCommit((el) => save({ name: el.value }))} />} />
      <Row label="Correo" desc="Adonde te escribe ronin: lo que eliges en Notificaciones. GitHub no se lo da al tablero." ctl={<input className="aj-in" type="email" maxLength={254} data-ajme="email" defaultValue={p.email ?? ''} placeholder="persona@gmail.com" aria-label="Correo" ref={onCommit((el) => save({ email: el.value }))} />} />
    </Sec>
    {d.linear.length > 0 && (
      <Sec title="Linear" lead="Quién eres en cada equipo, para sugerirte como líder de un proyecto o como asignado.">
        {d.linear.map((t) => (
          <Row key={t.repo} label={t.workspace ?? t.team} desc={`${t.repo} · equipo ${t.team}`} ctl={
            <select className="aj-in" data-ajlinear={t.repo} aria-label={`Tu usuario en ${t.team}`} defaultValue={t.people.some((x) => x.id === p.linear?.[t.repo]?.id) ? p.linear![t.repo].id : ''} ref={onCommit((el) => save({ linear: { repo: t.repo, id: el.value || null } }))}>
              <option value="">—</option>{t.people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          } />
        ))}
      </Sec>
    )}
    <Sec title="Interfaz">
      <Row label="Tema" desc="Solo en este navegador." ctl={<div className="aj-seg"><button data-ajtheme="dark" aria-pressed={dark} onClick={() => theme('dark')}>Oscuro</button><button data-ajtheme="light" aria-pressed={!dark} onClick={() => theme('light')}>Claro</button></div>} />
    </Sec>
  </>;
}

// The emails ronin sends the team (#174, stage 4), each person choosing theirs repo by repo.
export function Notifications({ d }: { d: Page }) {
  const shell = useShell();
  const repoColor = useRepoColor();
  const queryClient = useQueryClient();
  const change = useChange();
  const email = d.perfil.email;
  const toggle = (repo: string, event: string, on: boolean) => change(async () => {
    const { notificaciones } = (await ok(client.api.settings.notifications.$post({ json: { repo, event, on } }))) as { notificaciones: NotificationsData[] };
    queryClient.setQueryData<Page>(['settings'], (x) => x && { ...x, notificaciones });
    shell.toast('Guardado.');
  });
  return <>
    <h1>Notificaciones</h1><p className="lead">Qué te avisa ronin, repo por repo. Lo eliges tú: nadie más lo cambia. {email ? <>Llegan a <b>{email}</b>.</> : ''}</p>
    {email ? null : <div className="aj-note warn"><b>Sin correo.</b> Agrégalo en <SectionLink to="perfil">Perfil</SectionLink> para recibir algo.</div>}
    {d.notificaciones.map((n) => (
      <section className="aj-sec" key={n.repo}><h2><i className="aj-sq" style={{ background: repoColor(n.repo) }} />{n.repo}</h2>{n.chosen ? null : <p className="aj-d">Todavía no elegiste: es lo que te llegaba antes (portal.notifyTo de repos.json y NOTIFY_TO).</p>}<div className="aj-card">
        {EVENTS.map(([id, name, desc]) => <Row key={id} label={name} desc={desc} ctl={<Switch on={n.events.includes(id)} data-ajev={n.repo} data-e={id} disabled={!email} label={`${name} de ${n.repo}`} onToggle={() => toggle(n.repo, id, !n.events.includes(id))} />} />)}
      </div></section>
    ))}
    <p className="aj-foot">Si nadie del equipo recibe un aviso de un repo, va a <code>NOTIFY_TO</code>{d.notifyTo ? ` (${d.notifyTo})` : ''}, para que nunca se pierda.</p>
  </>;
}
