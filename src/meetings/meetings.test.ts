import { beforeEach, describe, expect, it } from 'vitest';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../core/config.js';
import { extractPasted } from './extract.js';
import { createMeeting, DuplicateMeeting, getMeeting, listMeetings, meetingDir, meetingTitle, readNotes, readOriginal } from './meetings.js';

const SC = 'redmotos/shoppingcart';
const BM = 'Bmedical/bmedical';
const NOTES = 'Exportar pedidos: el equipo de bodega pidió bajar a Excel la lista de pedidos con los filtros puestos.';
const NOW = new Date('2026-10-17T20:00:00Z');

beforeEach(async () => {
  await rm(config.meetings.dataDir, { recursive: true, force: true });
});

describe('createMeeting', () => {
  it('keeps the notes and the file in the meeting\'s folder, readable only by ronin', async () => {
    const file = { name: 'Seguimiento semanal – 16 oct.txt', data: Buffer.from(NOTES) };
    const m = await createMeeting({ repo: SC, by: 'Oskr814', notes: { kind: 'text', text: NOTES }, file, at: '2026-10-16T21:00:00.000Z', link: 'https://meet.google.com/abc' }, NOW);
    expect(m).toMatchObject({
      number: 1, repo: SC, title: 'Seguimiento semanal – 16 oct', by: 'Oskr814', status: 'pending', at: '2026-10-16T21:00:00.000Z', link: 'https://meet.google.com/abc',
      source: { kind: 'text', name: file.name, bytes: file.data.length, file: 'original.txt' }, chars: NOTES.length,
      events: [{ kind: 'uploaded', by: 'Oskr814', at: NOW.toISOString() }],
    });
    expect(await getMeeting(1)).toEqual(m);
    expect(await readNotes(1)).toBe(NOTES);
    expect(await readOriginal(m)).toEqual(file.data);
    expect((await stat(join(meetingDir(1), 'notes.txt'))).mode & 0o777).toBe(0o600);
    expect((await stat(meetingDir(1))).mode & 0o777).toBe(0o700);
  });

  it('numbers them across repos, and pasted notes have no file', async () => {
    await createMeeting({ repo: SC, by: 'a', notes: extractPasted(NOTES) }, NOW);
    const m = await createMeeting({ repo: BM, by: 'a', notes: extractPasted(`Otra reunión. ${NOTES}`) }, NOW);
    expect(m.number).toBe(2);
    expect(m.source).toEqual({ kind: 'pasted' });
    expect(await readOriginal(m)).toBeNull();
    expect((await listMeetings()).map((x) => x.number)).toEqual([1, 2]);
  });

  it('refuses the same notes twice in a repo, even at once, but not in another repo', async () => {
    const one = () => createMeeting({ repo: SC, by: 'a', notes: extractPasted(NOTES) }, NOW);
    const results = await Promise.allSettled([one(), one()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(DuplicateMeeting);
    expect(refused.reason.message).toBe('Esas notas ya se subieron: R-1.');
    // Pasted again with other spacing, it's still the same notes.
    await expect(createMeeting({ repo: SC, by: 'b', notes: extractPasted(`${NOTES.toUpperCase()}\n`) }, NOW)).rejects.toBeInstanceOf(DuplicateMeeting);
    expect((await createMeeting({ repo: BM, by: 'a', notes: extractPasted(NOTES) }, NOW)).number).toBe(2);
  });

  it('lets the notes in again when the meeting that had them never got written', async () => {
    await createMeeting({ repo: SC, by: 'a', notes: extractPasted(NOTES) }, NOW);
    await rm(meetingDir(1), { recursive: true });
    expect((await createMeeting({ repo: SC, by: 'a', notes: extractPasted(NOTES) }, NOW)).number).toBe(2);
    expect(JSON.parse(await readFile(join(config.meetings.dataDir, 'meetings', 'counter.json'), 'utf8')).last).toBe(2);
  });
});

describe('meetingTitle', () => {
  it('is the person\'s, else the file\'s name, else the notes\' first line, cut short', () => {
    expect(meetingTitle('  Planificación  del ciclo ', 'x.pdf', NOTES)).toBe('Planificación del ciclo');
    expect(meetingTitle('', 'Llamada bodega 9-oct.docx', NOTES)).toBe('Llamada bodega 9-oct');
    expect(meetingTitle(undefined, undefined, `\n\n  Resumen de la reunión\n${NOTES}`)).toBe('Resumen de la reunión');
    expect(meetingTitle(undefined, undefined, 'x'.repeat(300))).toHaveLength(120);
  });
});
