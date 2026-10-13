import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePortRange, PreviewReservations } from './preview-reservations.js';

let root: string;
let reservations: PreviewReservations;
let a: { dir: string; prNumber: number };
let b: { dir: string; prNumber: number };
let c: { dir: string; prNumber: number };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'preview-reservations-'));
  reservations = new PreviewReservations(join(root, 'reservations'));
  a = { dir: join(root, 'preview-pr-1'), prNumber: 1 };
  b = { dir: join(root, 'preview-pr-2'), prNumber: 2 };
  c = { dir: join(root, 'preview-pr-3'), prNumber: 3 };
  for (const owner of [a, b, c]) await mkdir(owner.dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A range nothing on the test host listens on, most likely.
const range = { min: 21500, max: 21502 };

describe('allocatePort', () => {
  it('never hands out the same port twice, even to concurrent callers', async () => {
    const ports = await Promise.all([reservations.allocatePort(range, a), reservations.allocatePort(range, b), reservations.allocatePort(range, a)]);
    expect(new Set(ports).size).toBe(3);
    await expect(reservations.allocatePort(range, c)).rejects.toThrow(/no quedan puertos libres/);
  });

  it('gives a port back once its owner releases it', async () => {
    const port = await reservations.allocatePort({ min: 21500, max: 21500 }, a);
    await reservations.releasePorts(a.dir);
    expect(await reservations.allocatePort({ min: 21500, max: 21500 }, b)).toBe(port);
  });

  it('takes over a port whose owner worktree is gone', async () => {
    await reservations.allocatePort({ min: 21500, max: 21500 }, a);
    await rm(a.dir, { recursive: true });
    expect(await reservations.allocatePort({ min: 21500, max: 21500 }, b)).toBe(21500);
  });

  it('skips a port something else on the host is listening on', async () => {
    const server: Server = await new Promise((resolve) => {
      const s = createServer();
      s.listen(21500, '0.0.0.0', () => resolve(s));
    });
    try {
      expect(await reservations.allocatePort({ min: 21500, max: 21501 }, a)).toBe(21501);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('acquireSlot', () => {
  it('allows up to max previews per repo and names who holds them', async () => {
    expect(await reservations.acquireSlot('acme-product', 2, a)).toEqual({ ok: true });
    expect(await reservations.acquireSlot('acme-product', 2, b)).toEqual({ ok: true });
    expect(await reservations.acquireSlot('acme-product', 2, c)).toEqual({ ok: false, holders: [1, 2] });
  });

  it('keeps the slot of a preview asking again, and counts each repo apart', async () => {
    await reservations.acquireSlot('acme-product', 1, a);
    expect(await reservations.acquireSlot('acme-product', 1, a)).toEqual({ ok: true });
    expect(await reservations.acquireSlot('acme-other', 1, b)).toEqual({ ok: true });
  });

  it('frees a slot on release, and when its owner worktree is gone', async () => {
    await reservations.acquireSlot('acme-product', 1, a);
    await reservations.releaseSlots(a.dir);
    expect(await reservations.acquireSlot('acme-product', 1, b)).toEqual({ ok: true });
    await rm(b.dir, { recursive: true });
    expect(await reservations.acquireSlot('acme-product', 1, c)).toEqual({ ok: true });
  });
});

describe('parsePortRange', () => {
  it('reads min-max and rejects anything else', () => {
    expect(parsePortRange('20000-20999')).toEqual({ min: 20000, max: 20999 });
    expect(() => parsePortRange('20999-20000')).toThrow(/inválido/);
    expect(() => parsePortRange('80-90')).toThrow(/inválido/);
    expect(() => parsePortRange('20000')).toThrow(/inválido/);
  });
});
