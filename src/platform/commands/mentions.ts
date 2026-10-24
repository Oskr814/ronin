import { getDb } from '@platform/db/db.js';
import { replyToComment, type Comment } from '@platform/github/github.js';
import { claimCommand, finishCommand, getCommand, listCommands, noteCommand, requeueCommand, waitingCommands, type Command } from './store.js';

// What's asked of ronin on a PR from the tablero in words (#446): an
// adjustment, the answers to its questions. To the flows that answer
// mentions they're one more, of kind "command", with the command's id; what
// the agent answers goes back to the command (actions/executors.ts), never
// to GitHub.

export const TABLERO_MENTION_KINDS = ['adjust', 'answer'];

const asMention = (c: Command): Comment => ({ id: Number(c.id), kind: 'command', body: String(c.args.text ?? ''), reactionsEyes: 0, authorLogin: c.requestedBy, createdAt: c.createdAt });

// The ones waiting on the PR, as mentions. None without a database.
export async function tableroMentions(repo: string, prNumber: number): Promise<Comment[]> {
  const db = getDb();
  if (!db) return [];
  return (await waitingCommands(db, repo, prNumber, TABLERO_MENTION_KINDS)).map(asMention);
}

export const isTableroMention = (m: Pick<Comment, 'kind'>) => m.kind === 'command';

// Takes them before the agent runs: the ones another process took first are left out.
export async function claimTableroMentions<T extends Pick<Comment, 'id' | 'kind'>>(mentions: T[]): Promise<T[]> {
  const db = getDb();
  const kept: T[] = [];
  for (const m of mentions) {
    if (!isTableroMention(m)) kept.push(m);
    else if (db && (await claimCommand(db, String(m.id)))) kept.push(m);
  }
  return kept;
}

// Answered: done. Not answered (the run failed): back to waiting, saying so.
export async function settleTableroMention(m: Pick<Comment, 'id'>, outcome: { error?: string } = {}): Promise<void> {
  const db = getDb();
  if (!db) return;
  if (outcome.error) await requeueCommand(db, String(m.id), `No pude terminarlo (${outcome.error}). Lo vuelvo a intentar en la próxima pasada.`);
  else await finishCommand(db, String(m.id));
}

// The ones taken that nobody answered or ended (a pass that left them for
// later): back to waiting, quietly.
export async function releaseTableroMentions(ids: number[]): Promise<void> {
  const db = getDb();
  if (!db) return;
  for (const id of ids) {
    const command = await getCommand(db, String(id));
    if (command?.status === 'running') await requeueCommand(db, String(id));
  }
}

// The agent's answer to one.
export async function answerTableroMention(id: number, body: string): Promise<void> {
  const db = getDb();
  if (!db) throw new Error('sin base de datos: no se puede responder un pedido del tablero');
  await noteCommand(db, String(id), body);
}

// What was asked before from the tablero on the PR (and its issue), with
// what ronin answered: for the agent, the part of the conversation that
// isn't on GitHub. The newest last; `except`, the ones it's answering now.
export async function tableroConversation(repo: string, numbers: number[], except: number[] = [], limit = 10): Promise<string> {
  const db = getDb();
  if (!db) return '';
  const done = (await listCommands(db, repo, numbers, 50)).filter((c) => !except.includes(Number(c.id)) && c.messages.length > 0).slice(0, limit).reverse();
  return done.map((c) => `- ${c.createdAt.slice(0, 16).replace('T', ' ')}, ${c.requestedBy} pidió (${c.kind}${typeof c.args.app === 'string' ? ` ${c.args.app}` : ''})${typeof c.args.text === 'string' && c.args.text ? `: ${c.args.text}` : ''}\n${c.messages.map((m) => `  ronin respondió: ${m.text.replace(/\n/g, '\n  ')}`).join('\n')}`).join('\n');
}

// The issue commands that can be asked from the tablero (#446), each as the
// command it would be on GitHub, so the flows that read those parse it.
export const TABLERO_ISSUE_KINDS = ['spike', 'spec', 'explore'];

const asIssueCommand = (c: Command, login: string): Comment => ({
  ...asMention(c),
  body: `@${login} /${c.kind}${typeof c.args.app === 'string' ? ` ${c.args.app}` : ''}${typeof c.args.text === 'string' && c.args.text ? ` ${c.args.text}` : ''}`,
});

// The ones waiting on an issue, as its comments with the command. None without a database.
export async function tableroIssueCommands(repo: string, issueNumber: number, login: string): Promise<Comment[]> {
  const db = getDb();
  if (!db) return [];
  return (await waitingCommands(db, repo, issueNumber, TABLERO_ISSUE_KINDS)).map((c) => asIssueCommand(c, login));
}

// The issues with one waiting, for the pass that only looks at the issues updated lately.
// `repo`, asked only with a database.
export async function issuesWithTableroCommands(repo: () => string): Promise<number[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db.selectFrom('commands').select('number').distinct()
    .where('repo', '=', repo()).where('kind', 'in', TABLERO_ISSUE_KINDS).where('status', '=', 'queued').execute();
  return rows.map((r) => r.number);
}

// Answers whoever asked: in the command, or on GitHub as before.
export async function replyToAsker(number: number, comment: Pick<Comment, 'id' | 'kind'>, body: string): Promise<void> {
  if (isTableroMention(comment)) await answerTableroMention(comment.id, body);
  else await replyToComment(number, comment, body);
}

// What's asked on an exploration PR's findings from the tablero (#446): a
// `ficha` command is one more comment on the finding's file (its path, and
// the words the comment would have), an `explore-general` one a general
// comment that mentions ronin. The flows that read those take them as such.
export const TABLERO_FICHA_KIND = 'ficha';
export const TABLERO_GENERAL_KIND = 'explore-general';

export interface TableroFileComment {
  id: number;
  kind: 'command';
  path: string;
  body: string;
  authorLogin: string;
  reactionsEyes: number;
  createdAt: string;
}

export async function tableroFichaComments(repo: string, prNumber: number): Promise<TableroFileComment[]> {
  const db = getDb();
  if (!db) return [];
  return (await waitingCommands(db, repo, prNumber, [TABLERO_FICHA_KIND])).map((c) => ({
    id: Number(c.id), kind: 'command', path: String(c.args.path ?? ''), body: String(c.args.body ?? ''), authorLogin: c.requestedBy, reactionsEyes: 0, createdAt: c.createdAt,
  }));
}

export async function tableroGeneralComments(repo: string, prNumber: number, login: string): Promise<Comment[]> {
  const db = getDb();
  if (!db) return [];
  return (await waitingCommands(db, repo, prNumber, [TABLERO_GENERAL_KIND])).map((c) => ({ ...asMention(c), body: `@${login} ${String(c.args.text ?? '')}` }));
}
