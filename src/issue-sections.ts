// The parts of an issue body ronin writes in answer to a mention (see
// issue-request.ts). Pure: the supervisor composes the new body here, so
// whatever the agent says, the original description above stays exactly as
// a person wrote it — the agent never gets to rewrite the body itself.
//
// Sections ronin keeps up to date (the scope, its history) live between
// HTML-comment markers, so a later change finds and replaces them wherever
// they ended up, even after someone edited text around them.

function markers(key: string): { start: string; end: string } {
  return { start: `<!-- ronin:${key} -->`, end: `<!-- /ronin:${key} -->` };
}

// What sits between the markers, or undefined when the section isn't there.
export function readSection(body: string, key: string): string | undefined {
  const { start, end } = markers(key);
  const from = body.indexOf(start);
  if (from === -1) return undefined;
  const to = body.indexOf(end, from + start.length);
  if (to === -1) return undefined;
  return body.slice(from + start.length, to).trim();
}

// Replaces the section in place, or appends it at the end of the body.
export function upsertSection(body: string, key: string, content: string): string {
  const { start, end } = markers(key);
  const block = `${start}\n${content.trim()}\n${end}`;
  const from = body.indexOf(start);
  const to = from === -1 ? -1 : body.indexOf(end, from + start.length);
  if (from !== -1 && to !== -1) return `${body.slice(0, from)}${block}${body.slice(to + end.length)}`;
  return `${body.trimEnd()}\n\n${block}\n`;
}

export interface ScopeChange {
  // The whole scope as it stands after the change, in Markdown.
  alcance: string;
  // One line: what changed.
  cambio: string;
  // The comment that asked for it.
  commentUrl: string;
  // YYYY-MM-DD.
  date: string;
}

const SCOPE_HEADING = '## Alcance';
const SCOPE_NOTE = '_Este es el alcance vigente: reemplaza al de la descripción original, que queda arriba como registro del pedido inicial._';
const HISTORY_HEADING = '## Cambios de alcance';

// The "- …" lines of the history so far, oldest first.
function historyEntries(body: string): string[] {
  const section = readSection(body, 'cambios-de-alcance');
  if (!section) return [];
  return section.split('\n').filter((line) => line.startsWith('- '));
}

// Rewrites the current scope and adds one line to its history — the scope
// first, so a reader meets the scope before the log of how it got there.
export function applyScopeChange(body: string, change: ScopeChange): string {
  const entry = `- ${change.date}: ${change.cambio.replace(/\s*\n\s*/g, ' ').trim()} ([pedido](${change.commentUrl}))`;
  const history = [...historyEntries(body), entry];
  let next = upsertSection(body, 'alcance', `${SCOPE_HEADING}\n\n${SCOPE_NOTE}\n\n${change.alcance.trim()}`);
  next = upsertSection(next, 'cambios-de-alcance', `${HISTORY_HEADING}\n\n${history.join('\n')}`);
  return next;
}

// An investigation never replaces an earlier one: each goes at the end, with
// its date and the comment that asked for it, same as /spike's section.
export function appendInvestigation(body: string, opts: { contexto: string; commentUrl: string; date: string }): string {
  return `${body.trimEnd()}\n\n## Contexto adicional (${opts.date})\n\n_Pedido en [este comentario](${opts.commentUrl})._\n\n${opts.contexto.trim()}\n`;
}
