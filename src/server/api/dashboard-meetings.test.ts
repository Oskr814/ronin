import { describe, it, expect } from 'vitest';
import type { RepoEntry } from '../../core/repo-context.js';
import { createMeeting, type Meeting } from '../../meetings/index.js';
import { meetingOriginal, parseUpload } from './dashboard-meetings.js';

const SC = 'redmotos/shoppingcart';
const ENTRIES = [{ productRepo: SC }] as RepoEntry[];
const NOTES = 'Búsqueda de clientes: buscar "nanez" sin tilde no encuentra a nadie; se acordó darle prioridad.';
const dataUrl = (text: string, type = 'text/markdown') => `data:${type};base64,${Buffer.from(text).toString('base64')}`;

describe('parseUpload', () => {
  it('takes a file, by what it is and not what the browser says', async () => {
    const up = await parseUpload({ repo: SC, file: { name: '../../notas\u0000.md', data: dataUrl(`# Notas\n\n${NOTES}`, 'application/pdf') }, link: 'https://meet.google.com/abc', at: '2026-10-16T15:00:00-06:00' }, ENTRIES, 'Oskr814');
    expect(up).toMatchObject({ repo: SC, by: 'Oskr814', link: 'https://meet.google.com/abc', at: '2026-10-16T21:00:00.000Z', notes: { kind: 'text', text: `# Notas\n\n${NOTES}` }, file: { name: '.._.._notas_.md' } });
  });

  it('takes pasted text', async () => {
    expect(await parseUpload({ repo: SC, text: NOTES, title: ' Reunión ' }, ENTRIES, 'a')).toEqual({ repo: SC, by: 'a', title: 'Reunión', notes: { kind: 'text', text: NOTES } });
  });

  it('says what is wrong', async () => {
    const bad = (body: Record<string, unknown>) => parseUpload(body, ENTRIES, 'a');
    await expect(bad({ repo: 'otro/repo', text: NOTES })).rejects.toThrow('Elige un repo');
    await expect(bad({ repo: SC })).rejects.toThrow('uno de los dos');
    await expect(bad({ repo: SC, text: NOTES, file: { name: 'a', data: dataUrl(NOTES) } })).rejects.toThrow('uno de los dos');
    await expect(bad({ repo: SC, text: NOTES, link: 'javascript:alert(1)' })).rejects.toThrow('http o https');
    await expect(bad({ repo: SC, text: NOTES, at: 'mañana' })).rejects.toThrow('La fecha');
    await expect(bad({ repo: SC, file: { name: 'a', data: 'no es un data URL' } })).rejects.toThrow('no llegó bien');
    await expect(bad({ repo: SC, file: { name: 'a.png', data: dataUrl('\u0000PNG', 'image/png') } })).rejects.toThrow('Solo se aceptan');
  });
});

describe('meetingOriginal', () => {
  it('is always a download, never shown in the dashboard', async () => {
    const data = Buffer.from(NOTES);
    const m = await createMeeting({ repo: SC, by: 'a', notes: { kind: 'text', text: NOTES }, file: { name: 'Notas "16 oct".md', data } });
    const out = await meetingOriginal(m);
    expect(out?.data).toEqual(data);
    expect(out?.headers).toEqual({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="R-${m.number}.txt"; filename*=UTF-8''Notas%20%2216%20oct%22.md`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
  });

  it('has nothing for pasted notes', async () => {
    expect(await meetingOriginal({ number: 3, source: { kind: 'pasted' } } as Meeting)).toBeNull();
  });
});
