import { getDb } from '@platform/db/db.js';
import type { Comment } from '@platform/github/github.js';
import { claimCommand, finishCommand, listCommands, noteCommand, requeueCommand, waitingCommands, type Command } from './store.js';

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
