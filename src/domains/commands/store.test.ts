import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@platform/db/db.js';
import { EventHub, type LiveEvent } from '@platform/events/bus.js';
import { TEST_DATABASE_URL, testDb } from '@platform/db/testing.js';
import { createCommand, finishCommand, getCommand, listCommands, noteCommand, startCommand } from './store.js';

describe.skipIf(!TEST_DATABASE_URL)('what is asked of ronin from the tablero', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let hub: EventHub;
  const heard: LiveEvent[] = [];
  beforeAll(async () => {
    ({ db, drop } = await testDb());
    hub = new EventHub(TEST_DATABASE_URL!);
    hub.subscribe((event) => heard.push(event));
    await hub.start();
  });
  afterAll(async () => {
    await hub.stop();
    await drop();
  });
  beforeEach(async () => {
    heard.length = 0;
    await db.deleteFrom('commands').execute();
  });
  const mine = () => heard.filter((e) => e.type === 'command' && e.repo === 'acme/web');

  it('keeps who asked, what ronin answers and how it ended, and tells the screens each step', async () => {
    const { command, existing } = await createCommand(db, { repo: 'acme/web', number: 12, kind: 'preview', args: { app: 'backoffice' }, requestedBy: 'ana-dev', dedupeKey: 'preview:acme/web#12' });
    expect(existing).toBe(false);
    expect(command).toMatchObject({ repo: 'acme/web', number: 12, kind: 'preview', args: { app: 'backoffice' }, requestedBy: 'ana-dev', status: 'queued', messages: [] });
    await startCommand(db, command.id);
    await noteCommand(db, command.id, 'Levantando la app…');
    await noteCommand(db, command.id, 'Lista.', 'run-1');
    const done = await finishCommand(db, command.id);
    expect(done).toMatchObject({ status: 'done', runId: 'run-1', error: null });
    expect(done!.messages.map((m) => m.text)).toEqual(['Levantando la app…', 'Lista.']);
    expect(done!.finishedAt).not.toBeNull();
    await expect.poll(() => mine().map((e) => e.status)).toEqual(['queued', 'running', 'running', 'running', 'done']);
    expect(mine()[0]).toEqual({ type: 'command', repo: 'acme/web', number: 12, id: command.id, kind: 'preview', status: 'queued' });
  });

  it('gives the one already waiting or running to whoever asks the same again, and a new one once it ended', async () => {
    const key = 'preview:acme/web#12';
    const first = await createCommand(db, { repo: 'acme/web', number: 12, kind: 'preview', requestedBy: 'ana-dev', dedupeKey: key });
    const again = await createCommand(db, { repo: 'acme/web', number: 12, kind: 'preview', requestedBy: 'beto-dev', dedupeKey: key });
    expect(again).toMatchObject({ existing: true, command: { id: first.command.id, requestedBy: 'ana-dev' } });
    await startCommand(db, first.command.id);
    expect((await createCommand(db, { repo: 'acme/web', number: 12, kind: 'preview', requestedBy: 'beto-dev', dedupeKey: key })).existing).toBe(true);
    await finishCommand(db, first.command.id, { error: 'no levantó' });
    expect(await getCommand(db, first.command.id)).toMatchObject({ status: 'failed', error: 'no levantó' });
    const after = await createCommand(db, { repo: 'acme/web', number: 12, kind: 'preview', requestedBy: 'beto-dev', dedupeKey: key });
    expect(after.existing).toBe(false);
    expect(after.command.id).not.toBe(first.command.id);
  });

  it('lists an item’s commands, its issue’s and its PR’s, newest first', async () => {
    const a = await createCommand(db, { repo: 'acme/web', number: 3, kind: 'question', requestedBy: 'ana-dev' });
    const b = await createCommand(db, { repo: 'acme/web', number: 4, kind: 'preview', requestedBy: 'ana-dev' });
    await createCommand(db, { repo: 'acme/web', number: 5, kind: 'preview', requestedBy: 'ana-dev' });
    await createCommand(db, { repo: 'acme/otro', number: 3, kind: 'preview', requestedBy: 'ana-dev' });
    expect((await listCommands(db, 'acme/web', [3, 4])).map((c) => c.id)).toEqual([b.command.id, a.command.id]);
    expect(await listCommands(db, 'acme/web', [])).toEqual([]);
  });
});
