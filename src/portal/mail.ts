import type { Mail } from '../core/notifier.js';
import type { LinkKind, PortalUser } from './accounts.js';
import type { PortalApp } from './apps.js';

// The portal's emails (#114): plain text, and a simple HTML with inline
// styles (what email clients render). They go out from GMAIL_USER, the same
// account as the blockers, for every repo.

export const PORTAL_FROM_NAME = 'ronin · Pedidos de ajustes';

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function html(paragraphs: string[], button: { label: string; url: string }, portalUrl: string): string {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;color:#1C2236;font-size:15px;line-height:1.5">
${paragraphs.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join('\n')}
<p style="margin:18px 0"><a href="${esc(button.url)}" style="background:#1C2236;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">${esc(button.label)}</a></p>
<p style="margin:18px 0 0;color:#686F82;font-size:12.5px;border-top:1px solid #D9DCE1;padding-top:10px">Pedidos de ajustes · ${esc(portalUrl.replace(/^https?:\/\//, ''))}</p>
</div>`;
}

const appList = (apps: PortalApp[]) => apps.map((a) => `${a.org} · ${a.name}`);

// The link to set a password: an invitation (a new account) or a reset.
export function linkMail(user: PortalUser, kind: LinkKind, url: string, portalUrl: string, apps: PortalApp[]): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  if (kind === 'invite') {
    const where = appList(apps);
    const lines = [
      `Hola ${first},`,
      'Te dieron acceso al portal de pedidos de ajustes: ahí puedes pedir cambios pequeños en las aplicaciones y ver cómo avanzan.',
      ...(where.length ? [`Puedes pedir en: ${where.join(', ')}.`] : []),
      'Para entrar, crea tu contraseña con este enlace. Vence en 24 horas.',
    ];
    return {
      to: user.email,
      subject: 'Te dieron acceso al portal de pedidos de ajustes',
      text: `${lines.join('\n\n')}\n\n${url}\n\nTu usuario es ${user.email}.`,
      html: html([...lines.map(esc), `Tu usuario es <b>${esc(user.email)}</b>.`], { label: 'Crear mi contraseña', url }, portalUrl),
    };
  }
  const lines = [
    `Hola ${first},`,
    'Pediste cambiar tu contraseña del portal de pedidos de ajustes. Usa este enlace; vence en 24 horas.',
    'Si no fuiste tú, ignora este correo: tu contraseña sigue igual.',
  ];
  return {
    to: user.email,
    subject: 'Cambiar tu contraseña del portal de pedidos',
    text: `${lines.join('\n\n')}\n\n${url}`,
    html: html(lines.map(esc), { label: 'Cambiar mi contraseña', url }, portalUrl),
  };
}

export const linkUrl = (portalUrl: string, token: string) => `${portalUrl}/contrasena#t=${token}`;
