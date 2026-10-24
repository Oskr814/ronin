import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDb, type Db } from '@platform/db/db.js';
import { TEST_DATABASE_URL, testDb } from '@platform/db/testing.js';
import { answerTableroMention, claimTableroMentions, issuesWithTableroCommands, replyToAsker, settleTableroMention, tableroConversation, tableroIssueCommands, tableroMentions } from './mentions.js';
import { createCommand, getCommand } from './store.js';

// An adjustment asked from the tablero (#446), as the review-request run
// sees it: one more mention, taken once, answered back in the command.
describe.skipIf(!TEST_DATABASE_URL)('what is asked in words from the tablero, as mentions', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => {
    setDb(null);
    await drop();
  });
  beforeEach(async () => {
    setDb(db);
    await db.deleteFrom('commands').execute();
  });

  it('hands the waiting ones over as mentions of kind "command", taken by one run only', async () => {
    const { command } = await createCommand(db, { repo: 'acme/web', number: 42, kind: 'adjust', args: { text: 'Agregá un test para el total en cero' }, requestedBy: 'ana-dev' });
    await createCommand(db, { repo: 'acme/web', number: 42, kind: 'preview', requestedBy: 'ana-dev' });
    await createCommand(db, { repo: 'acme/web', number: 43, kind: 'adjust', args: { text: 'otro PR' }, requestedBy: 'ana-dev' });
    const mentions = await tableroMentions('acme/web', 42);
    expect(mentions).toEqual([expect.objectContaining({ id: Number(command.id), kind: 'command', body: 'Agregá un test para el total en cero', authorLogin: 'ana-dev' })]);
    const github = { id: 999, kind: 'issue' as const };
    expect(await claimTableroMentions([github, ...mentions])).toEqual([github, mentions[0]]);
    expect(await claimTableroMentions(mentions)).toEqual([]);
    expect(await tableroMentions('acme/web', 42)).toEqual([]);
  });

  it('keeps what the agent answers, ends it once answered, and puts it back to wait if the run failed', async () => {
    const { command } = await createCommand(db, { repo: 'acme/web', number: 42, kind: 'adjust', args: { text: 'Más corto' }, requestedBy: 'ana-dev' });
    const [m] = await claimTableroMentions(await tableroMentions('acme/web', 42));
    await settleTableroMention(m, { error: 'se cortó' });
    expect(await getCommand(db, command.id)).toMatchObject({ status: 'queued', messages: [expect.objectContaining({ text: expect.stringContaining('se cortó') })] });
    const [again] = await claimTableroMentions(await tableroMentions('acme/web', 42));
    await answerTableroMention(again.id, 'Listo: lo acorté.');
    await settleTableroMention(again);
    expect(await getCommand(db, command.id)).toMatchObject({ status: 'done' });
  });

  it('gives the agent what was asked before and what it answered, without the ones it answers now', async () => {
    const old = await createCommand(db, { repo: 'acme/web', number: 42, kind: 'adjust', args: { text: 'Sacá el log' }, requestedBy: 'ana-dev' });
    await answerTableroMention(Number(old.command.id), 'Lo saqué.');
    const now = await createCommand(db, { repo: 'acme/web', number: 42, kind: 'adjust', args: { text: 'Ahora el test' }, requestedBy: 'beto-dev' });
    await answerTableroMention(Number(now.command.id), 'Empiezo.');
    const said = await tableroConversation('acme/web', [42], [Number(now.command.id)]);
    expect(said).toContain('ana-dev pidió (adjust): Sacá el log');
    expect(said).toContain('ronin respondió: Lo saqué.');
    expect(said).not.toContain('Ahora el test');
  });

  it('writes a /spike, /spec or /explore asked from the tablero as the command it would be on the issue, and answers it there', async () => {
    const { command } = await createCommand(db, { repo: 'acme/web', number: 901, kind: 'spike', args: { app: 'webapp', text: 'cómo se calcula el total' }, requestedBy: 'ana-dev' });
    await createCommand(db, { repo: 'acme/web', number: 902, kind: 'explore', args: { app: 'backoffice' }, requestedBy: 'ana-dev' });
    expect(await tableroIssueCommands('acme/web', 901, 'ronin-bot')).toEqual([expect.objectContaining({ id: Number(command.id), kind: 'command', body: '@ronin-bot /spike webapp cómo se calcula el total' })]);
    expect((await issuesWithTableroCommands(() => 'acme/web')).sort()).toEqual([901, 902]);
    await replyToAsker(901, { id: Number(command.id), kind: 'command' }, 'Esto es lo que encontré.');
    expect((await getCommand(db, command.id))!.messages.map((m) => m.text)).toEqual(['Esto es lo que encontré.']);
  });
});
