import { describe, expect, it, vi } from 'vitest';

vi.mock('./worker-launch.js', () => ({ launchWorker: vi.fn(() => 4321) }));
const { launchWorker } = await import('./worker-launch.js');
const { trackedWorker } = await import('./tracked.js');

const NOW = Date.parse('2026-10-21T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DEAD = 2 ** 22 + 12345;

interface Doc { number: number; updatedAt: string; open: boolean; worker?: { pid: number; since: string } }

const make = (docs: Doc[]) => {
  const noted: unknown[] = [];
  const worker = trackedWorker<Doc>({
    name: 'domains/things/worker',
    area: 'cosas',
    subject: (n) => `C-${n}`,
    list: async () => docs,
    pending: (d) => d.open,
    noteLaunch: async (n, pid, by) => { noted.push([n, pid, by]); },
  });
  return { worker, noted };
};

describe('trackedWorker', () => {
  it('launches the worker with the document and notes its pid', async () => {
    const { worker, noted } = make([]);
    await worker.launch(7);
    expect(launchWorker).toHaveBeenCalledWith('domains/things/worker', { number: 7 });
    expect(noted).toEqual([[7, 4321, 'server']]);
  });

  it('relaunches only the pending documents whose worker is gone, after a grace period', async () => {
    const { worker } = make([
      { number: 1, updatedAt: ago(60 * 60_000), open: true, worker: { pid: DEAD, since: ago(10 * 60_000) } },
      { number: 2, updatedAt: ago(60 * 60_000), open: true, worker: { pid: process.pid, since: ago(10 * 60_000) } },
      { number: 3, updatedAt: ago(60 * 60_000), open: true, worker: { pid: DEAD, since: ago(30_000) } },
      { number: 4, updatedAt: ago(60 * 60_000), open: false },
      { number: 5, updatedAt: ago(30_000), open: true },
      { number: 6, updatedAt: ago(10 * 60_000), open: true },
    ]);
    const relaunch = vi.fn(async () => {});
    await worker.sweep(NOW, relaunch);
    expect(relaunch.mock.calls).toEqual([[1, 'tick'], [6, 'tick']]);
  });

  it('goes on with the rest when one relaunch fails', async () => {
    const { worker } = make([
      { number: 1, updatedAt: ago(60 * 60_000), open: true },
      { number: 2, updatedAt: ago(60 * 60_000), open: true },
    ]);
    const relaunch = vi.fn(async (n: number) => { if (n === 1) throw new Error('sin repo'); });
    await worker.sweep(NOW, relaunch);
    expect(relaunch).toHaveBeenCalledTimes(2);
  });
});
