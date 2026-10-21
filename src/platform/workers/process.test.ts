import { describe, expect, it } from 'vitest';
import { pidAlive } from './process.js';

describe('pidAlive', () => {
  it('is true for a running process, and false for one that is not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('is false for what is not a pid', () => {
    for (const pid of [undefined, null, 'x', 0, -1, 1.5, NaN]) expect(pidAlive(pid)).toBe(false);
  });
});
