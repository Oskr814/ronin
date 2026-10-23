import type { Mail } from '@platform/notify/notifier.js';
import type { LinkKind, PortalUser } from './accounts.js';
import type { PortalApp } from './apps.js';
import { interviewRecord } from './interview.js';
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

// To the person, when ronin left them questions about a big request
// (#225): they answer them in the portal, in a form.
export function interviewMail(request: PortalRequest, user: PortalUser, portalUrl: string): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  const reply = request.messages.filter((m) => m.from === 'ronin').at(-1);
  const count = reply?.questions?.length ?? 0;
  const lines = [
    `Hola ${first},`,
    `ronin te dejó ${count === 1 ? 'una pregunta' : `${count} preguntas`} sobre tu pedido P-${request.number} ("${request.title}"). Con tus respuestas, el equipo de desarrollo lo tiene claro desde el principio.`,
  ];
  const url = requestUrl(portalUrl, request.number);
  return {
    to: user.email,
    subject: `ronin te dejó unas preguntas: ${request.title}`,
    text: `${lines.join('\n\n')}\n\n${reply?.text ?? ''}\n\nRespóndelas desde el portal: ${url}`,
    html: html([...lines.map(esc), `<i>${esc(reply?.text ?? '').replace(/\n/g, '<br>')}</i>`], { label: 'Responder las preguntas', url }, portalUrl),
  };
}

// To the person, when ronin wrote what it understood after the interview
// (#225): they confirm it, or correct it, in the portal.
export function understoodMail(request: PortalRequest, user: PortalUser, portalUrl: string): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  const decisions = request.messages.filter((m) => m.from === 'ronin').at(-1)?.understood?.decisions ?? [];
  const lines = [
    `Hola ${first},`,
    `Con tus respuestas, ronin escribió lo que entendió de tu pedido P-${request.number} ("${request.title}"). Revísalo: si está bien, se lo pasa al equipo de desarrollo; si no, dile qué corregir.`,
  ];
  const list = decisions.map((d) => `${d.topic}: ${d.decision}`);
  const url = requestUrl(portalUrl, request.number);
  return {
    to: user.email,
    subject: `Revisa lo que entendí: ${request.title}`,
    text: `${lines.join('\n\n')}\n\n${list.map((l) => `- ${l}`).join('\n')}\n\nRevísalo en el portal: ${url}`,
    html: html([...lines.map(esc), list.map(esc).join('<br>')], { label: 'Revisar el resumen', url }, portalUrl),
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
      : request.bug
        ? `Le enviamos el error que reportaste en P-${request.number} ("${request.title}") al equipo de desarrollo, con tu descripción, tus imágenes y lo que encontró ronin al intentar reproducirlo.`
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
    request.bug
      ? `Listo: el error que reportaste en P-${request.number} ("${request.title}") ya está corregido y el arreglo sale en la próxima actualización de la aplicación.`
      : `Listo: el cambio de tu pedido P-${request.number} ("${request.title}") ya está hecho y sale en la próxima actualización de la aplicación.`,
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

// To the person, once the release that carried their changes deployed
// (#158): one mail for all of theirs it carried, each with its link.
export function deployedMail(requests: PortalRequest[], user: PortalUser, portalUrl: string): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  if (requests.length > 1) {
    const what = (r: PortalRequest) => `P-${r.number}: ${r.bug ? 'el arreglo del error ' : ''}"${r.title}"`;
    const intro = [`Hola ${first},`, `Estos ${requests.length} pedidos tuyos ya están en la aplicación:`];
    const outro = 'Si no los ves, recarga la página. Gracias por pedirlos.';
    return {
      to: user.email,
      subject: `Ya están en la aplicación: ${requests.length} de tus pedidos`,
      text: `${intro.join('\n\n')}\n\n${requests.map((r) => `- ${what(r)}\n  ${requestUrl(portalUrl, r.number)}`).join('\n')}\n\n${outro}`,
      html: html([...intro.map(esc), requests.map((r) => `<a href="${esc(requestUrl(portalUrl, r.number))}" style="color:#1C2236;font-weight:600">P-${r.number}</a>: ${esc(what(r).replace(/^P-\d+: /, ''))}`).join('<br>'), esc(outro)], { label: 'Ver mis pedidos', url: portalUrl }, portalUrl),
    };
  }
  const [request] = requests;
  const lines = [
    `Hola ${first},`,
    request.bug
      ? `El arreglo del error que reportaste en P-${request.number} ("${request.title}") ya está en la aplicación.`
      : `El cambio de tu pedido P-${request.number} ("${request.title}") ya está en la aplicación.`,
    'Si no lo ves, recarga la página. Gracias por pedirlo.',
  ];
  const url = requestUrl(portalUrl, request.number);
  return {
    to: user.email,
    subject: `Ya está en la aplicación: ${request.title}`,
    text: `${lines.join('\n\n')}\n\n${url}`,
    html: html(lines.map(esc), { label: 'Ver el pedido', url }, portalUrl),
  };
}

// To the person, when the team closed its issue: solved, or not for now.
export function closedMail(request: PortalRequest, user: PortalUser, portalUrl: string): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  const solved = request.status === 'resolved';
  // The team's reason, when they wrote one closing it from the tablero.
  const note = request.closeNote?.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) ?? [];
  const lines = [
    `Hola ${first},`,
    solved
      ? `El equipo de desarrollo resolvió tu pedido P-${request.number} ("${request.title}").${note.length ? '' : ' Si era un cambio en la aplicación, sale en una próxima actualización.'}`
      : `El equipo de desarrollo revisó tu pedido P-${request.number} ("${request.title}") y decidió no hacerlo por ahora${note.length ? ':' : '.'}`,
    ...note,
    solved ? 'Gracias por pedirlo.' : 'Si necesitas algo más, puedes enviar un pedido nuevo desde el portal.',
  ];
  const url = requestUrl(portalUrl, request.number);
  return {
    to: user.email,
    subject: `${solved ? 'Resuelto' : 'Revisamos tu pedido'}: ${request.title}`,
    text: `${lines.join('\n\n')}\n\n${url}`,
    html: html(lines.map((line) => esc(line).replace(/\n/g, '<br>')), { label: 'Ver el pedido', url }, portalUrl),
  };
}

// To the dev team (teamTo in notify.ts), when ronin opened the PR of an approved
// request: it merges once one of them approves it and CI is green.
export function teamPrMail(request: PortalRequest, user: PortalUser | undefined, to: string, prUrl: string): Mail {
  const who = user ? `${user.name} <${user.email}>` : request.userId;
  const text = [
    `ronin abrió el PR del pedido P-${request.number} del portal: ${request.title}`,
    `De: ${who}`,
    `App: ${request.repo} · ${request.app}`,
    request.status === 'fixing' ? 'Es el arreglo de un error que reportó: ronin lo reprodujo con un test que falla y el arreglo de prueba lo pasó a verde.' : request.verdict?.proposal ? `Lo que aprobó: ${request.verdict.proposal}` : null,
    `PR: ${prUrl}`,
    request.devDecision?.kind === 'deploy'
      ? `${request.devDecision.by} eligió aprobarlo y desplegarlo: ronin lo aprueba a su nombre y lo mergea cuando CI está en verde (ronin:auto-merge).`
      : 'Tiene ronin:auto-merge: se mergea cuando alguien del equipo lo aprueba y CI está en verde. Entonces se le avisa a la persona que sale en la próxima actualización.',
    request.issue ? `Issue: ${request.issue.url}` : null,
  ].filter(Boolean).join('\n\n');
  return { to, subject: `[ronin] PR para aprobar: pedido P-${request.number} del portal (${request.title})`, text };
}

// The team signs as one to the person (#353): who wrote stays in the tablero.
export const TEAM_NAME = 'Equipo de desarrollo';

// To the person, when someone of the team wrote to them about their request.
export function teamWroteMail(request: PortalRequest, user: PortalUser, portalUrl: string, text: string, images: number): Mail {
  const first = user.name.split(/\s+/)[0] || user.name;
  const said = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const lines = [
    `Hola ${first},`,
    `El ${TEAM_NAME.toLowerCase()} te escribió sobre tu pedido P-${request.number} ("${request.title}")${said.length ? ':' : '.'}`,
    ...said,
    images ? `Adjuntó ${images === 1 ? 'una imagen' : `${images} imágenes`}: está${images === 1 ? '' : 'n'} en el pedido.` : '',
    'Puedes responderle desde el pedido.',
  ].filter(Boolean);
  const url = requestUrl(portalUrl, request.number);
  return {
    to: user.email,
    subject: `El equipo te escribió sobre tu pedido P-${request.number}`,
    text: `${lines.join('\n\n')}\n\n${url}`,
    html: html(lines.map((line) => esc(line).replace(/\n/g, '<br>')), { label: 'Ver el pedido', url }, portalUrl),
  };
}

// To the team (teamTo in notify.ts), when the person answered them: it's
// theirs, ronin doesn't read it.
export function personRepliedMail(request: PortalRequest, user: PortalUser | undefined, to: string, text: string, images: number, dashboardUrl: string): Mail {
  const who = user ? `${user.name} <${user.email}>` : request.userId;
  const body = [
    `${user?.name ?? 'La persona'} le respondió al equipo sobre el pedido P-${request.number} del portal: ${request.title}`,
    `De: ${who}`,
    text || '(sin texto)',
    images ? `[${images} imagen(es), en el pedido]` : null,
    dashboardUrl ? `Responder desde el tablero: ${dashboardUrl}/pedidos/${request.number}` : null,
  ].filter(Boolean).join('\n\n');
  return { to, subject: `[ronin] ${user?.name ?? 'La persona'} respondió sobre el pedido P-${request.number}: ${request.title}`, text: body, team: true };
}

// To the dev team (teamTo in notify.ts), when a request waits for a dev to
// decide before ronin makes it (#353): what the person approved (or the
// error ronin can fix), and where to decide.
export function decideMail(request: PortalRequest, user: PortalUser | undefined, to: string, dashboardUrl: string): Mail {
  const who = user ? `${user.name} <${user.email}>` : request.userId;
  const repro = request.bug?.reproductions.at(-1);
  const link = dashboardUrl ? `${dashboardUrl}/pedidos/${request.number}` : null;
  const text = [
    `El pedido P-${request.number} del portal espera que alguien del equipo decida antes de que ronin lo haga: ${request.title}`,
    `De: ${who}`,
    `App: ${request.repo} · ${request.app}`,
    request.bug
      ? `Es un error que reportó: ronin lo reprodujo con un test que falla y un arreglo chico lo pasó a verde.${repro?.summary ? `\n\nCausa:\n${repro.summary}` : ''}`
      : `Aprobó el prototipo${request.verdict?.proposal ? `: ${request.verdict.proposal}` : '.'}`,
    request.verdict?.summary ? `Resumen técnico:\n${request.verdict.summary}` : null,
    'Se puede:\n- Aprobar y desplegar: ronin hace el cambio, aprueba el PR a nombre de quien decidió y lo mergea con el CI en verde.\n- Aprobar con revisión: ronin hace el cambio y el PR espera que un dev lo apruebe.\n- No hacerlo: el pedido se cierra con el motivo, que le llega a la persona.',
    link ? `Decidir en el tablero: ${link}` : 'Se decide en el tablero, en Pedidos del portal.',
  ].filter(Boolean).join('\n\n');
  return { to, subject: `[ronin] Pedido P-${request.number} para decidir: ${request.title}`, text };
}

const MAX_PATCH = 30_000;

// What the team is told a request is.
function teamKind(request: PortalRequest): string {
  if (request.status === 'approved' || (request.status === 'awaiting-dev' && !request.bug)) return 'prototipo aprobado';
  if (request.status === 'fixing') return 'error a corregir';
  if (request.decision?.kind === 'rejected') return 'prototipo no aprobado';
  if (request.bug) return request.bug.reproductions.at(-1)?.reproduced ? 'error reproducido' : 'error sin reproducir';
  return request.verdict?.kind === 'minor' ? 'ajuste chico' : 'pedido grande';
}

// To the dev team (teamTo in notify.ts): a request that's theirs now (too big, or
// its prototype turned down or impossible), with its issue and its
// conversation. `patch` is the last prototype's diff, or a reported error's
// last reproduction's.
// The interview (#225), for the team's mail: the decisions, or the answers.
function interviewLines(request: PortalRequest): string | null {
  const record = interviewRecord(request);
  if (!record) return null;
  if (!record.rounds.length) return 'La persona prefirió enviarlo sin responder las preguntas de ronin.';
  const u = record.understood;
  const lines = u
    ? [`Lo que definió la persona (${record.ended === 'confirmed' ? 'lo confirmó' : 'no lo confirmó'}):`, ...u.decisions.map((d) => `- ${d.topic}: ${d.decision}`), ...(u.out.length ? [`Queda fuera: ${u.out.join('; ')}`] : []), ...(u.team.length ? [`Para decidir el equipo: ${u.team.join('; ')}`] : [])]
    : ['Lo que respondió la persona:', ...record.rounds.flat().map((a) => `- ${a.question} → ${a.answer}`)];
  return lines.join('\n');
}

export function teamRequestMail(request: PortalRequest, user: PortalUser | undefined, to: string, dataDir: string, patch?: string): Mail {
  const kind = teamKind(request);
  const who = user ? `${user.name} <${user.email}>` : request.userId;
  const conversation = request.messages
    .map((m) => `${m.from === 'ronin' ? 'ronin' : m.from === 'team' ? `${TEAM_NAME} (${m.by})` : user?.name ?? 'Persona'} (${m.at.slice(0, 16).replace('T', ' ')} UTC):\n${m.text}${m.images.length ? `\n[${m.images.length} imagen(es)]` : ''}`)
    .join('\n\n');
  const v = request.verdict;
  const last = request.prototypes?.at(-1);
  const repro = request.bug?.reproductions.at(-1);
  const test = repro?.test;
  const text = [
    `Pedido P-${request.number} del portal: ${request.title}`,
    `De: ${who}`,
    `App: ${request.repo} · ${request.app}`,
    request.issue ? `Issue: ${request.issue.url}` : null,
    request.bug ? `Es un reporte de error; ronin ${repro ? `intentó reproducirlo ${request.bug.reproductions.length === 1 ? 'una vez' : `${request.bug.reproductions.length} veces`}` : 'no llegó a reproducirlo'}.` : request.status === 'approved' || request.decision ? `La persona vio ${request.prototypes?.length === 1 ? 'el prototipo' : `${request.prototypes?.length ?? 0} prototipos`}: ${kind}.` : `ronin lo clasificó como ${kind}.`,
    v?.proposal ? `Propuesta: ${v.proposal}` : null,
    v?.reason ? `Motivo: ${v.reason}` : null,
    interviewLines(request),
    v?.summary ? `Resumen técnico:\n${v.summary}` : null,
    last ? `El prototipo ${last.round}:\n${last.summary}` : null,
    request.bug?.steps ? `Cómo reproducirlo, según ronin:\n${request.bug.steps}` : null,
    repro?.steps.length ? `Lo que hizo ronin:\n${repro.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}` : null,
    repro?.summary ? `${repro.reproduced ? 'Causa' : 'Lo que sospecha ronin'}:\n${repro.summary}` : null,
    test ? `Test (${test.kind === 'e2e' ? 'e2e' : 'directo'}): ${test.name}${test.file ? ` en ${test.file}` : ''}, ${test.red ? (test.green ? 'rojo sin el arreglo y verde con él' : 'rojo en la rama base') : 'no falla con datos de prueba'}.` : null,
    `Conversación:\n\n${conversation}`,
    request.messages.some((m) => m.images.length) || last || repro ? `Las imágenes${last?.patch || repro?.patch ? ` y los diffs de ${repro ? 'las reproducciones' : 'los prototipos'}` : ''} están en el runner, en ${dataDir}.` : null,
    patch ? `Diff ${repro ? 'de la reproducción' : `del prototipo ${last?.round ?? ''}`}:\n\n${patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n… (recortado)` : patch}` : null,
  ].filter(Boolean).join('\n\n');
  return { to, subject: `[ronin] Pedido P-${request.number} del portal (${kind}): ${request.title}`, text };
}
