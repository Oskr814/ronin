import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { config } from '@platform/config/config.js';
import { createUser } from './accounts.js';
import { addPersonMessage, createRequest, getRequest, updateRequest, type PortalRequest } from './requests.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@platform/notify/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }));
const commentOnIssue = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@platform/github/github.js', () => ({ commentOnIssue: (...args: unknown[]) => commentOnIssue(...args) }));
vi.mock('@platform/config/repos.js', () => ({ loadRepos: async () => [{ productRepo: 'acme/tienda', productRepoPath: '/repo' }] }));

const { canReplyToTeam, replyToTeam, seenByTeam, writeToPerson } = await import('./team-conversation.js');
const { waitsOn } = await import('./board.js');

const PNG = { ext: 'png' as const, data: Buffer.from('x') };

async function teams(over: Partial<PortalRequest> = {}): Promise<number> {
  const user = await createUser({ email: `persona${Math.random()}@gmail.com`, name: 'Ana Pérez', grants: [], createdBy: 'oskr814' });
  const r = await createRequest({ userId: user.id, repo: 'acme/tienda', app: 'web', text: 'Un reporte nuevo', images: [] });
  await updateRequest(r.number, (x) => {
    x.status = 'big';
    Object.assign(x, over);
  });
  return r.number;
}

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  sendMail.mockClear();
  commentOnIssue.mockClear();
});

describe('the team and the person write to each other (#353)', () => {
  it('the team writes: the person gets it by mail, signed as the team, and the request stays as it is', async () => {
    const n = await teams();
    expect(canReplyToTeam((await getRequest(n))!)).toBe(false);
    const r = await writeToPerson(n, { text: '¿Lo necesitas por sucursal o en total?', images: [PNG], by: 'ana-dev' });
    expect(r.status).toBe('big');
    expect(r.messages.at(-1)).toMatchObject({ from: 'team', by: 'ana-dev', text: '¿Lo necesitas por sucursal o en total?', images: [expect.stringMatching(/\.png$/)] });
    expect((await getRequest(n))?.events?.map((e) => e.kind)).toEqual(['team-message', 'mail']);
    const mail = sendMail.mock.calls[0][0] as { subject: string; text: string };
    expect(mail.subject).toBe(`El equipo te escribió sobre tu pedido P-${n}`);
    expect(mail.text).toContain('¿Lo necesitas por sucursal o en total?');
    expect(mail.text).not.toContain('ana-dev');
    // No issue yet: nothing to copy; it goes in its body when it opens.
    expect(commentOnIssue).not.toHaveBeenCalled();
    expect(canReplyToTeam(r)).toBe(true);
  });

  it('the person answers the team: the team hears it, the issue gets both, and ronin is not woken', async () => {
    const n = await teams({ status: 'approved', issue: { number: 31, url: 'u' } });
    await writeToPerson(n, { text: 'Hola @alguien', images: [], by: 'ana-dev' });
    expect(commentOnIssue).toHaveBeenCalledWith(31, expect.stringContaining('**Equipo → persona (ana-dev, desde el tablero)**'));
    expect(commentOnIssue.mock.calls[0][1]).toContain('> Hola @​alguien');
    sendMail.mockClear();
    const r = await replyToTeam(n, 'Por sucursal.', []);
    expect(r).toMatchObject({ status: 'approved', personReplied: expect.any(String) });
    expect(r.messages.at(-1)).toMatchObject({ from: 'person', to: 'team', text: 'Por sucursal.' });
    expect(r.worker).toBeUndefined();
    expect(waitsOn(r)).toBe('team');
    expect(sendMail.mock.calls[0][0]).toMatchObject({ subject: expect.stringContaining(`Ana Pérez respondió sobre el pedido P-${n}`), text: expect.stringContaining('Por sucursal.') });
    expect(commentOnIssue).toHaveBeenLastCalledWith(31, expect.stringContaining('**Persona → equipo (Ana Pérez, desde el portal)**'));
    // Opened from the tablero, or answered: it's seen.
    await seenByTeam(n);
    expect((await getRequest(n))?.personReplied).toBeUndefined();
  });

  it('only while the team has it, and the person only answers once the team wrote', async () => {
    const closed = await teams({ status: 'done' });
    await expect(writeToPerson(closed, { text: 'Hola', images: [], by: 'ana-dev' })).rejects.toThrow(/ya no está en manos del equipo/);
    const quiet = await teams();
    await expect(replyToTeam(quiet, 'Hola', [])).rejects.toThrow(/no espera una respuesta/);
    await expect(writeToPerson(quiet, { text: ' ', images: [], by: 'ana-dev' })).rejects.toThrow(/Escribe algo/);
    // Writing to ronin is still what it was.
    await expect(addPersonMessage(quiet, 'Hola', [])).rejects.toThrow(/no espera una respuesta/);
  });
});
