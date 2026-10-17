import type { Mail } from '../core/notifier.js';
import type { LinkKind, PortalUser } from './accounts.js';
import type { PortalApp } from './apps.js';
import type { PortalRequest } from './requests.js';

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

export const requestUrl = (portalUrl: string, n: number) => `${portalUrl}/p/${n}`;

// To the person, when ronin answered them (a question, an answer, a
// proposal): the reply itself, so they don't need to keep the page open.
export function replyMail(request: PortalRequest, user: PortalUser, portalUrl: string): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  const reply = request.messages.filter((m) => m.from === 'ronin').at(-1)?.text ?? '';
  const ask = request.status === 'asking';
  const lines = [`Hola ${first},`, `ronin ${ask ? 'te hizo una pregunta' : 'te respondió'} sobre tu pedido P-${request.number} ("${request.title}"):`];
  const url = requestUrl(portalUrl, request.number);
  return {
    to: user.email,
    subject: `${ask ? 'ronin te hizo una pregunta' : 'ronin te respondió'}: ${request.title}`,
    text: `${lines.join('\n\n')}\n\n${reply}\n\n${ask ? 'Respóndele desde el portal: ' : ''}${url}`,
    html: html([...lines.map(esc), `<i>${esc(reply).replace(/\n/g, '<br>')}</i>`], { label: ask ? 'Responder' : 'Ver el pedido', url }, portalUrl),
  };
}

// To the person, when ronin judged the request too big for the portal.
export function bigRequestMail(request: PortalRequest, user: PortalUser, portalUrl: string): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  const lines = [
    `Hola ${first},`,
    `Tu pedido P-${request.number} ("${request.title}") necesita más trabajo que un ajuste chico, así que se lo enviamos al equipo de desarrollo con tu descripción y tus imágenes.`,
    'Te escribimos cuando esté resuelto.',
  ];
  const url = requestUrl(portalUrl, request.number);
  return {
    to: user.email,
    subject: `Recibimos tu pedido: ${request.title}`,
    text: `${lines.join('\n\n')}\n\n${url}`,
    html: html(lines.map(esc), { label: 'Ver el pedido', url }, portalUrl),
  };
}

// To the dev team (NOTIFY_TO): a request ronin classified, with its
// conversation, until the portal opens issues for them (#114).
export function teamRequestMail(request: PortalRequest, user: PortalUser | undefined, to: string, imagesDir: string): Mail {
  const kind = request.verdict?.kind === 'minor' ? 'ajuste chico' : 'pedido grande';
  const who = user ? `${user.name} <${user.email}>` : request.userId;
  const conversation = request.messages
    .map((m) => `${m.from === 'ronin' ? 'ronin' : user?.name ?? 'Persona'} (${m.at.slice(0, 16).replace('T', ' ')} UTC):\n${m.text}${m.images.length ? `\n[${m.images.length} imagen(es)]` : ''}`)
    .join('\n\n');
  const v = request.verdict;
  const text = [
    `Pedido P-${request.number} del portal: ${request.title}`,
    `De: ${who}`,
    `App: ${request.repo} · ${request.app}`,
    `ronin lo clasificó como ${kind}.`,
    v?.proposal ? `Propuesta: ${v.proposal}` : null,
    v?.reason ? `Motivo: ${v.reason}` : null,
    v?.summary ? `Resumen técnico:\n${v.summary}` : null,
    `Conversación:\n\n${conversation}`,
    request.messages.some((m) => m.images.length) ? `Las imágenes están en el runner, en ${imagesDir}.` : null,
  ].filter(Boolean).join('\n\n');
  return { to, subject: `[ronin] Pedido P-${request.number} del portal (${kind}): ${request.title}`, text };
}
