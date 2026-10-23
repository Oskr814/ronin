import { describe, expect, it } from 'vitest';
import { nextTag, patternProblem } from './tag-pattern.js';

const tags = (...t: string[]) => new Set(t);

describe("an automatic batch's tag (#353)", () => {
  it('reads the version from the last release and adds to it', () => {
    expect(nextTag({ pattern: 'v{major}.{minor}.{patch+1}', lastTag: 'v1.4.7', day: '2026-10-22', tags: tags('v1.4.7') })).toEqual({ tag: 'v1.4.8' });
    expect(nextTag({ pattern: 'v{major}.{minor+1}.0', lastTag: 'v1.4.0', day: '2026-10-22', tags: tags() })).toEqual({ tag: 'v1.5.0' });
  });

  it("numbers the day's batches by date", () => {
    expect(nextTag({ pattern: '{yyyy}.{mm}.{dd}-{n}', lastTag: 'v1.0.0', day: '2026-10-22', tags: tags() })).toEqual({ tag: '2026.10.22-1' });
    expect(nextTag({ pattern: '{yyyy}.{mm}.{dd}-{n}', lastTag: '2026.10.22-1', day: '2026-10-22', tags: tags('2026.10.22-1') })).toEqual({ tag: '2026.10.22-2' });
  });

  it("doesn't make one up when the last tag doesn't fit the pattern, or there's none", () => {
    expect(nextTag({ pattern: 'v{major}.{minor}.{patch+1}', lastTag: 'release-42', day: '2026-10-22', tags: tags() })).toEqual({ problem: 'base-mismatch' });
    expect(nextTag({ pattern: 'v{major}.{minor}.{patch+1}', lastTag: null, day: '2026-10-22', tags: tags() })).toEqual({ problem: 'no-base' });
  });

  it('says what is wrong with a pattern', () => {
    expect(patternProblem('v{major}.{minor}.{patch+1}')).toBeNull();
    expect(patternProblem('{yyyy}.{mm}.{dd}-{n}')).toBeNull();
    expect(patternProblem('v{major}.{minor}.{patch}')).toMatch(/subir algún número/);
    expect(patternProblem('{yyyy}.{mm}.{dd}')).toMatch(/\{n\}/);
    expect(patternProblem('v{version}')).toMatch(/solo puede usar/);
    expect(patternProblem('v 1/{patch+1}')).toMatch(/letras, números/);
    expect(patternProblem('release')).toMatch(/un número que cambie/);
  });
});
