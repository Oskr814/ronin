import { useState } from 'react';
import { client, ok } from '../../api.js';
import { useShell } from '../../shell/hooks.js';
import { Row, Sec, Source, useChange } from './parts.js';
import { hhmm, what } from './model.js';
import type { Data } from './Settings.js';

// Conexiones: the credentials live in the server's .env and never go
// through the dashboard; this only says whether they're there and answer.
export function Connections({ data }: { data: Data }) {
  const shell = useShell();
  const change = useChange();
  const [busy, setBusy] = useState(false);
  const c = data.connections;
  if (!c) return <><h1>Conexiones</h1><div className="empty">Leyendo…</div></>;
  const st = (good: boolean, yes = 'Configurado', no = 'Falta') => (good ? <span className="ok-t">● {yes}</span> : <span className="bad">○ {no}</span>);
  const days = c.github.expires ? Math.round((Date.parse(c.github.expires) - Date.now()) / 86_400_000) : null;
  const testMail = async () => {
    setBusy(true);
    await change(async () => {
      const { to } = (await ok(client.api.settings.connections.mail.$post())) as { to: string };
      shell.toast(`Listo: mira tu correo (${to}).`);
    }, (message) => message);
    setBusy(false);
  };
  return <>
    <h1>Conexiones</h1><p className="lead">Las credenciales viven en <code>.env</code> del servidor y nunca pasan por el tablero: aquí solo se ve si están y si responden. Linear se configura en cada repo.</p>
    <Sec title="GitHub">
      <Row label="Token de ronin" desc={`PAT fine-grained de la cuenta ${c.github.login ?? 'de ronin'}.`} ctl={c.github.ok ? st(true, days !== null ? `Responde · vence en ${days} días` : 'Responde') : st(false, '', c.github.error ?? 'No responde')} src={<Source name="RONIN_GITHUB_TOKEN" />} />
      <Row label="OAuth App del tablero" desc="Con la que se entra al tablero." ctl={st(c.oauth)} src={<Source name="DASHBOARD_GITHUB_CLIENT_ID / _SECRET" />} />
      <Row label="Secreto de los webhooks" ctl={st(c.webhookSecret)} src={<Source name="WEBHOOK_SECRET" />} />
    </Sec>
    <Sec title="Correo">
      <Row label="Gmail" desc="El remitente de todos los correos de ronin." ctl={<span className="aj-ro">{c.gmail.user}</span>} src={<>{c.gmail.password ? null : <span className="bad">○ Falta la contraseña de aplicación</span>}<span className="aj-env">.env</span><code>GMAIL_USER / GMAIL_APP_PASSWORD</code></>} />
      <Row label="Probar" desc="Te manda un correo de prueba a ti, al de tu Perfil." ctl={<button className="btn-s" data-ajtestmail disabled={busy} onClick={testMail}>{busy ? 'Mandando…' : 'Mandar prueba'}</button>} />
    </Sec>
    <Sec title="Sesiones">
      <Row label="Firma del tablero" desc="Cambiarla cierra todas las sesiones." ctl={st(c.sessions.dashboard)} src={<Source name="DASHBOARD_SESSION_SECRET" />} />
      <Row label="Firma del portal" ctl={st(c.sessions.portal, 'Configurado', 'Falta: el portal está apagado')} src={<Source name="PORTAL_SESSION_SECRET" />} />
    </Sec>
  </>;
}

// Registro: every change made in Ajustes. It isn't deleted.
export function Log({ data }: { data: Data }) {
  const list = data.log;
  const rows = !list ? <div className="aj-row"><span className="m">Cargando…</span></div> : !list.length ? <div className="aj-row"><span className="m">Todavía nadie cambió nada.</span></div>
    : list.map((e, i) => (
      <div className="aj-log" key={i}>
        <span className="t" title={new Date(e.at).toLocaleString('es')}>{new Date(e.at).toLocaleDateString('es', { day: 'numeric', month: 'short' })} {hhmm(e.at)}</span>
        <span className="w">{e.login}</span>
        <div><b>{what(e.what)}</b><div><span className="from">{e.from}</span> → <span className="to">{e.to}</span></div></div>
      </div>
    ));
  return <><h1>Registro</h1><p className="lead">Cada cambio en Ajustes: quién, cuándo, qué había y qué quedó. No se borra.</p><div className="aj-card">{rows}</div></>;
}
