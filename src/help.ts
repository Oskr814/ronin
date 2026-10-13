// Deterministic, no-LLM handling for `@<login> /help` and for a command that
// is misspelled or used in the wrong place — see mentions.ts's
// handleMetaCommands, which intercepts these before any flow that would
// spend a `claude -p` run on them. Pure: no I/O, so every rule here is
// directly unit-testable.

export type CommandContext = 'pr' | 'issue';

interface CommandSpec {
  name: string;
  scopes: CommandContext[];
  usage: string;
  summary: string;
  // Checked against whatever follows the command token (e.g. " backoffice
  // revisá el checkout" for "/spike backoffice revisá el checkout", or ""
  // for a bare "/spike"). Omitted for a command with no required
  // arguments — fix-comments and help both take none.
  validateArgs?: (rest: string) => boolean;
  // Other spellings people reach for that mean the same command
  // ("/preview-stop" for "/preview stop"). Not listed in the table.
  aliases?: string[];
}

// /spike's one required argument — mirrors mentions.ts's SPIKE_COMMAND_RE,
// which is the actual parser; this only needs to know "is there something
// here at all" so a bare "/spike" gets a usage reply instead of silently
// going nowhere (see spike.ts: a candidate with no app_name has nothing
// actionable to build a task from, so it's dropped without a trace once it
// gets that far — this check exists to answer before it gets that far).
const SPIKE_HAS_APP_NAME_RE = /^\s+\S/;

export const COMMANDS_WIKI_URL = 'https://github.com/Oskr814/ronin/wiki/Comandos';

// Single source for every command the supervisor recognizes after a mention.
// Adding a command means adding it here too, or a correct use of it gets
// answered as "unknown command" instead of reaching its flow.
const COMMANDS: CommandSpec[] = [
  {
    name: 'fix-comments',
    scopes: ['pr'],
    usage: '/fix-comments',
    summary: 'Aplico en un solo pase los hilos de review abiertos, respondo en cada uno y resuelvo los que cambié. Para excluir un hilo, resolvelo antes.',
  },
  {
    name: 'preview',
    scopes: ['pr'],
    usage: '/preview [app] [qué datos querés]',
    aliases: ['preview-stop', 'preview-off', 'preview-down'],
    summary: 'Levanto la app con el código del PR, su base y sus seeds, preparo los datos que piden sus pasos de prueba (más lo que me pidas) y te paso una URL de la tailnet para probarla. Se baja sola al mergear o cerrar el PR; `/preview stop` la baja antes. No en PRs de forks.',
  },
  {
    name: 'spike',
    scopes: ['issue'],
    usage: '/spike <app> [instrucción]',
    summary: 'Investigo en solo lectura y agrego una sección de contexto al issue. Solo en issues que todavía no me asignaron.',
    validateArgs: (rest) => SPIKE_HAS_APP_NAME_RE.test(rest),
  },
  {
    name: 'spec',
    scopes: ['issue'],
    usage: '/spec <app> [instrucción]',
    summary: 'Convierto el pedido del issue en un spec: investigo, te pregunto lo que falte y abro un PR draft con el spec. Cuando lo marcás listo, lo implemento.',
    validateArgs: (rest) => SPIKE_HAS_APP_NAME_RE.test(rest),
  },
  {
    name: 'explore',
    scopes: ['issue'],
    usage: '/explore <app> [cantidad de funciones]',
    summary: 'Levanto la app, uso algunas de sus funciones como cada rol en desktop y mobile, y dejo las propuestas de mejora en el PR de exploración abierto (o abro uno).',
    validateArgs: (rest) => SPIKE_HAS_APP_NAME_RE.test(rest),
  },
  {
    name: 'help',
    scopes: ['pr', 'issue'],
    usage: '/help',
    summary: 'Muestro esta lista.',
  },
];

const FREE_TEXT_PR_SUMMARY =
  'En un PR mío, o en un hilo de review de cualquier PR (no fork): si el pedido es concreto lo aplico y respondo en ese hilo, si no te respondo por qué. En un comentario general del PR de otra persona: review de solo lectura enfocada en tu pedido.';

export type MetaCommand =
  | { kind: 'help' }
  | { kind: 'wrong-context'; command: string }
  | { kind: 'bad-usage'; command: string }
  | { kind: 'unknown'; token: string; suggestion?: string };

// `login` is not escaped for regex metacharacters — same reasoning as
// mentions.ts's mentionsHandle: it's operator config, and a GitHub login is
// only alphanumerics and hyphens. Only the token *right after* the mention
// counts, so "@ronin revisá /src/foo.ts" stays free text. `rest` is
// whatever follows that token on the same line, for validateArgs.
function commandToken(body: string, login: string): { token: string; rest: string } | null {
  const match = body.match(new RegExp(`\\B@${login}\\s+/([\\w-]+)([^\\n]*)`, 'i'));
  return match ? { token: match[1].toLowerCase(), rest: match[2] } : null;
}

// null means "not a meta-command": either there's no command token at all
// (free text) or it's a real command used correctly where it applies, so
// the caller lets it through to its normal flow.
export function classifyMetaCommand(body: string, login: string, context: CommandContext): MetaCommand | null {
  const parsed = commandToken(body, login);
  if (parsed === null) return null;
  const { token, rest } = parsed;
  if (token === 'help') return { kind: 'help' };
  const command = COMMANDS.find((c) => c.name === token || c.aliases?.includes(token));
  if (command) {
    if (!command.scopes.includes(context)) return { kind: 'wrong-context', command: command.name };
    if (command.validateArgs && !command.validateArgs(rest)) return { kind: 'bad-usage', command: command.name };
    return null;
  }
  const suggestion = suggestCommand(token, context);
  return suggestion ? { kind: 'unknown', token, suggestion } : { kind: 'unknown', token };
}

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

// Only suggests commands that apply in this context — suggesting one that
// would just bounce back as wrong-context isn't a useful correction.
export function suggestCommand(token: string, context: CommandContext): string | undefined {
  const candidates = COMMANDS.filter((c) => c.scopes.includes(context)).map((c) => c.name);
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = levenshtein(token, name);
    if (distance <= 2 && (!best || distance < best.distance)) best = { name, distance };
  }
  if (best) return best.name;
  return token.length >= 3 ? candidates.find((name) => name.startsWith(token)) : undefined;
}

function scopeLabel(scopes: CommandContext[]): string {
  return scopes.includes('pr') ? 'PRs' : 'issues';
}

export function renderCommandTable(login: string, context: CommandContext): string {
  const rows = COMMANDS.filter((c) => c.scopes.includes(context)).map((c) => `| \`@${login} ${c.usage}\` | ${c.summary} |`);
  if (context === 'pr') rows.unshift(`| \`@${login} <pedido>\` | ${FREE_TEXT_PR_SUMMARY} |`);
  return ['| Comando | Qué hace |', '|---|---|', ...rows].join('\n');
}

export function renderMetaReply(meta: MetaCommand, login: string, context: CommandContext): string {
  let intro: string;
  if (meta.kind === 'help') {
    intro = 'Estos son los comandos que podés usar acá:';
  } else if (meta.kind === 'wrong-context') {
    const command = COMMANDS.find((c) => c.name === meta.command);
    const where = command ? scopeLabel(command.scopes) : context === 'pr' ? 'issues' : 'PRs';
    intro = `\`/${meta.command}\` solo funciona en ${where}. Acá podés usar:`;
  } else if (meta.kind === 'bad-usage') {
    const command = COMMANDS.find((c) => c.name === meta.command);
    intro = `Uso: \`@${login} ${command?.usage}\`.`;
  } else {
    const guess = meta.suggestion ? ` ¿Quisiste decir \`/${meta.suggestion}\`?` : '';
    intro = `No conozco \`/${meta.token}\`.${guess} Estos son los comandos que podés usar acá:`;
  }
  return [intro, '', renderCommandTable(login, context), '', `Más detalle en la [wiki](${COMMANDS_WIKI_URL}).`].join('\n');
}

export const HELP_FOOTER_MARKER = '<!-- ronin:help -->';

// Appended by the supervisor (tick.ts's processSlicePr) to every PR ronin
// opens. Idempotent via the marker, so it's safe to call every tick.
export function withHelpFooter(body: string, login: string): string {
  if (body.includes(HELP_FOOTER_MARKER)) return body;
  const footer = [
    HELP_FOOTER_MARKER,
    '<details>',
    '<summary>🥷 Comandos de ronin</summary>',
    '',
    renderCommandTable(login, 'pr'),
    '',
    `Más detalle en la [wiki](${COMMANDS_WIKI_URL}).`,
    '</details>',
  ].join('\n');
  return body.trim() ? `${body.trimEnd()}\n\n${footer}` : footer;
}
