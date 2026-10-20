import { describe, expect, it } from 'vitest';
import { currentRunGroup, previewRunGroup, withRunGroup } from './run-group.js';

describe('run groups', () => {
  it('carries the group to whatever runs inside, however deep, and nowhere else', async () => {
    expect(currentRunGroup()).toBeUndefined();
    const seen = await withRunGroup('preview:7:t', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentRunGroup();
    });
    expect(seen).toBe('preview:7:t');
    expect(currentRunGroup()).toBeUndefined();
  });

  it("names a preview's group by its PR and when it started", () => {
    expect(previewRunGroup(7, new Date('2026-10-20T10:00:00Z'))).toBe('preview:7:2026-10-20T10:00:00.000Z');
  });
});
