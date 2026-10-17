import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile, rm, stat } from 'node:fs/promises';
import { config } from '../core/config.js';
import { addPersonMessage, createRequest, getRequest, listRequestsOf, requestImagePath, startedToday, updateRequest, MAX_PROTOTYPES, updateUnlessCancelled } from './requests.js';
import { sweepPortalRequests } from './launch.js';

vi.mock('../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
});

describe('portal requests', () => {
  it("a worker finishing on a cancelled request leaves it as it is", async () => {
    const r = await createRequest({ userId: 'u1', repo: 'a/b', app: 'web', text: 'Hola', images: [] });
    expect((await updateUnlessCancelled(r.number, (x) => { x.status = 'asking'; }))?.status).toBe('asking');
    await updateRequest(r.number, (x) => { x.status = 'cancelled'; });
    expect(await updateUnlessCancelled(r.number, (x) => { x.status = 'proposed'; })).toBeUndefined();
    expect((await getRequest(r.number))?.status).toBe('cancelled');
  });

  it('takes adjustments to a prototype until none are left', async () => {
    const r = await createRequest({ userId: 'u1', repo: 'a/b', app: 'web', text: 'Hola', images: [] });
    const shown = (count: number) => updateRequest(r.number, (x) => {
      x.status = 'proposed';
      x.prototypes = Array.from({ length: count }, (_, i) => ({ round: i + 1, summary: '', messageId: 1, at: '' }));
    });
    await shown(MAX_PROTOTYPES - 1);
    expect((await addPersonMessage(r.number, 'Más grande', [])).status).toBe('thinking');
    await shown(MAX_PROTOTYPES);
    await expect(addPersonMessage(r.number, 'Más', [])).rejects.toThrow(/no quedan ajustes/);
  });

  it('numbers them across repos, saves the images apart, and starts them thinking', async () => {
    const a = await createRequest({ userId: 'u1', repo: 'a/b', app: 'web', text: '  Cambiar el texto del botón\nmás detalle ', images: [{ ext: 'png', data: PNG }] });
    const b = await createRequest({ userId: 'u2', repo: 'c/d', app: 'app', text: '', images: [{ ext: 'png', data: PNG }] });
    expect([a.number, b.number]).toEqual([1, 2]);
    expect(a).toMatchObject({ status: 'thinking', title: 'Cambiar el texto del botón', questions: 0, messages: [{ id: 1, from: 'person', text: 'Cambiar el texto del botón\nmás detalle', images: ['1-1.png'] }] });
    expect(b.title).toBe('Pedido con imágenes');
    expect(await readFile(requestImagePath(1, '1-1.png'))).toEqual(PNG);
    expect((await stat(requestImagePath(1, '1-1.png'))).mode & 0o777).toBe(0o600);
    expect((await listRequestsOf('u1')).map((r) => r.number)).toEqual([1]);
  });

  it('takes the person’s answer only while ronin waits on them', async () => {
    const r = await createRequest({ userId: 'u1', repo: 'a/b', app: 'web', text: 'Hola', images: [] });
    await expect(addPersonMessage(r.number, 'Otra cosa', [])).rejects.toThrow(/no espera una respuesta/);
    await updateRequest(r.number, (x) => { x.status = 'asking'; });
    const next = await addPersonMessage(r.number, 'En las tres', [{ ext: 'png', data: PNG }]);
    expect(next).toMatchObject({ status: 'thinking', messages: [{ id: 1 }, { id: 2, text: 'En las tres', images: ['2-1.png'] }] });
    await expect(addPersonMessage(99, 'x', [])).rejects.toThrow(/No existe/);
  });

  it('counts the requests started today', async () => {
    await createRequest({ userId: 'u1', repo: 'a/b', app: 'web', text: 'uno', images: [] });
    await createRequest({ userId: 'u1', repo: 'a/b', app: 'web', text: 'dos', images: [], }, new Date(Date.now() - 3 * 24 * 3600_000));
    expect(await startedToday('u1')).toBe(1);
    expect(await startedToday('u2')).toBe(0);
  });

  it('the tick starts another worker for a request whose worker died', async () => {
    const r = await createRequest({ userId: 'u1', repo: 'a/b', app: 'web', text: 'uno', images: [] });
    const launch = vi.fn(async () => {});
    const later = Date.now() + 10 * 60_000;
    // Alive: this very process.
    await updateRequest(r.number, (x) => { x.worker = { pid: process.pid, since: new Date().toISOString() }; });
    await sweepPortalRequests(later, launch);
    expect(launch).not.toHaveBeenCalled();
    await updateRequest(r.number, (x) => { x.worker = { pid: 2 ** 22 + 12345, since: new Date().toISOString() }; });
    await sweepPortalRequests(later, launch);
    expect(launch).toHaveBeenCalledWith(r.number);
    // So is one whose prototype was on the way.
    launch.mockClear();
    await updateRequest(r.number, (x) => { x.status = 'minor'; });
    await sweepPortalRequests(later, launch);
    expect(launch).toHaveBeenCalledWith(r.number);
    // And an approved one still without its issue, not one that has it.
    launch.mockClear();
    await updateRequest(r.number, (x) => { x.status = 'approved'; });
    await sweepPortalRequests(later, launch);
    expect(launch).toHaveBeenCalledWith(r.number);
    launch.mockClear();
    await updateRequest(r.number, (x) => { x.issue = { number: 9, url: 'u' }; });
    await sweepPortalRequests(later, launch);
    expect(launch).not.toHaveBeenCalled();
    // So is one the team takes, until its issue is open.
    launch.mockClear();
    await updateRequest(r.number, (x) => { x.status = 'big'; delete x.issue; });
    await sweepPortalRequests(later, launch);
    expect(launch).toHaveBeenCalledWith(r.number);
    // Answered ones are left alone.
    launch.mockClear();
    await updateRequest(r.number, (x) => { x.status = 'asking'; });
    await sweepPortalRequests(later, launch);
    expect(launch).not.toHaveBeenCalled();
    expect((await getRequest(r.number))?.status).toBe('asking');
  });
});
