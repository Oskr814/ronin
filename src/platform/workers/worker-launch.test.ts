import { afterEach, describe, expect, it, vi } from 'vitest';
import { handWorkersTo, launchWorker } from './worker-launch.js';

afterEach(() => handWorkersTo(null));

describe('a worker of a process that hands them over', () => {
  it('goes where it is told, and no process starts', () => {
    const queue = vi.fn();
    handWorkersTo(queue);
    expect(launchWorker('domains/explorations/worker', { repo: 'acme/app', appName: 'web' })).toBeUndefined();
    expect(queue).toHaveBeenCalledWith('domains/explorations/worker', { repo: 'acme/app', appName: 'web' });
  });
});
