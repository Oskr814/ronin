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

// To the person, when the prototype is ready: they approve it, ask for an
// adjustment or turn it down in the portal (the images are only there,
// behind their login).
export function prototypeMail(request: PortalRequest, user: PortalUser, portalUrl: string): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  const lines = [
    `Hola ${first},`,
    `Ya está el prototipo de tu pedido P-${request.number} ("${request.title}"): son imágenes de cómo se ve hoy y de cómo quedaría con el cambio.`,
    'Míralo en el portal y dime si lo apruebas, si quieres ajustar algo o si no es lo que buscabas.',
  ];
  const url = requestUrl(portalUrl, request.number);
  return {
    to: user.email,
    subject: `Tu prototipo está listo: ${request.title}`,
    text: `${lines.join('\n\n')}\n\n${url}`,
    html: html(lines.map(esc), { label: 'Ver el prototipo', url }, portalUrl),
  };
}

// To the person, when the request goes to the dev team: too big for the
// portal, or they turned the prototype down.
export function bigRequestMail(request: PortalRequest, user: PortalUser, portalUrl: string): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  const lines = [
    `Hola ${first},`,
    request.decision?.kind === 'rejected'
      ? `Le enviamos tu pedido P-${request.number} ("${request.title}") al equipo de desarrollo, con tu descripción y lo que conversamos sobre el prototipo.`
      : `Tu pedido P-${request.number} ("${request.title}") necesita más trabajo que un ajuste chico, así que se lo enviamos al equipo de desarrollo con tu descripción y tus imágenes.`,
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

// To the person, when the change merged.
export function doneMail(request: PortalRequest, user: PortalUser, portalUrl: string): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  const lines = [
    `Hola ${first},`,
    `Listo: el cambio de tu pedido P-${request.number} ("${request.title}") ya está hecho y sale en la próxima actualización de la aplicación.`,
    'Gracias por pedirlo.',
  ];
  const url = requestUrl(portalUrl, request.number);
  return {
    to: user.email,
    subject: `Listo, sale en la próxima actualización: ${request.title}`,
    text: `${lines.join('\n\n')}\n\n${url}`,
    html: html(lines.map(esc), { label: 'Ver el pedido', url }, portalUrl),
  };
}

// To the person, when the team closed its issue: solved, or not for now.
export function closedMail(request: PortalRequest, user: PortalUser, portalUrl: string): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  const solved = request.status === 'resolved';
  const lines = [
    `Hola ${first},`,
    solved
      ? `El equipo de desarrollo resolvió tu pedido P-${request.number} ("${request.title}"). Si era un cambio en la aplicación, sale en una próxima actualización.`
      : `El equipo de desarrollo revisó tu pedido P-${request.number} ("${request.title}") y decidió no hacerlo por ahora.`,
    solved ? 'Gracias por pedirlo.' : 'Si necesitas algo más, puedes enviar un pedido nuevo desde el portal.',
  ];
  const url = requestUrl(portalUrl, request.number);
  return {
    to: user.email,
    subject: `${solved ? 'Resuelto' : 'Revisamos tu pedido'}: ${request.title}`,
    text: `${lines.join('\n\n')}\n\n${url}`,
    html: html(lines.map(esc), { label: 'Ver el pedido', url }, portalUrl),
  };
}

// To the dev team (NOTIFY_TO), when ronin opened the PR of an approved
// request: it merges once one of them approves it and CI is green.
export function teamPrMail(request: PortalRequest, user: PortalUser | undefined, to: string, prUrl: string): Mail {
  const who = user ? `${user.name} <${user.email}>` : request.userId;
  const text = [
    `ronin abrió el PR del pedido P-${request.number} del portal: ${request.title}`,
    `De: ${who}`,
    `App: ${request.repo} · ${request.app}`,
    request.verdict?.proposal ? `Lo que aprobó: ${request.verdict.proposal}` : null,
    `PR: ${prUrl}`,
    'Tiene ronin:auto-merge: se mergea cuando alguien del equipo lo aprueba y CI está en verde. Entonces se le avisa a la persona que sale en la próxima actualización.',
    request.issue ? `Issue: ${request.issue.url}` : null,
  ].filter(Boolean).join('\n\n');
  return { to, subject: `[ronin] PR para aprobar: pedido P-${request.number} del portal (${request.title})`, text };
}

const MAX_PATCH = 30_000;

// What the team is told a request is.
function teamKind(request: PortalRequest): string {
  if (request.status === 'approved') return 'prototipo aprobado';
  if (request.decision?.kind === 'rejected') return 'prototipo no aprobado';
  return request.verdict?.kind === 'minor' ? 'ajuste chico' : 'pedido grande';
}

// To the dev team (NOTIFY_TO): a request that's theirs now (too big, or
// its prototype turned down or impossible), with its issue and its
// conversation. `patch` is the last prototype's diff.
export function teamRequestMail(request: PortalRequest, user: PortalUser | undefined, to: string, dataDir: string, patch?: string): Mail {
  const kind = teamKind(request);
  const who = user ? `${user.name} <${user.email}>` : request.userId;
  const conversation = request.messages
    .map((m) => `${m.from === 'ronin' ? 'ronin' : user?.name ?? 'Persona'} (${m.at.slice(0, 16).replace('T', ' ')} UTC):\n${m.text}${m.images.length ? `\n[${m.images.length} imagen(es)]` : ''}`)
    .join('\n\n');
  const v = request.verdict;
  const last = request.prototypes?.at(-1);
  const text = [
    `Pedido P-${request.number} del portal: ${request.title}`,
    `De: ${who}`,
    `App: ${request.repo} · ${request.app}`,
    request.issue ? `Issue: ${request.issue.url}` : null,
    request.status === 'approved' || request.decision ? `La persona vio ${request.prototypes?.length === 1 ? 'el prototipo' : `${request.prototypes?.length ?? 0} prototipos`}: ${kind}.` : `ronin lo clasificó como ${kind}.`,
    v?.proposal ? `Propuesta: ${v.proposal}` : null,
    v?.reason ? `Motivo: ${v.reason}` : null,
    v?.summary ? `Resumen técnico:\n${v.summary}` : null,
    last ? `El prototipo ${last.round}:\n${last.summary}` : null,
    `Conversación:\n\n${conversation}`,
    request.messages.some((m) => m.images.length) || last ? `Las imágenes${last?.patch ? ' y los diffs de los prototipos' : ''} están en el runner, en ${dataDir}.` : null,
    patch ? `Diff del prototipo ${last?.round ?? ''}:\n\n${patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n… (recortado)` : patch}` : null,
  ].filter(Boolean).join('\n\n');
  return { to, subject: `[ronin] Pedido P-${request.number} del portal (${kind}): ${request.title}`, text };
}
