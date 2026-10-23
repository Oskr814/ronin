import { describe, it, expect } from 'vitest';
import { areaOf, patchScope } from './team-notes.js';

describe("a diff's scope, for the dev who decides (#406)", () => {
  it('counts the lines of each file and names the areas it touches', () => {
    const patch = [
      'diff --git a/apps/api/src/Orders.cs b/apps/api/src/Orders.cs',
      '--- a/apps/api/src/Orders.cs',
      '+++ b/apps/api/src/Orders.cs',
      '@@ -1,2 +1,2 @@',
      '-  return a;',
      '+  return b;',
      '+  // b',
      'diff --git a/apps/web/src/List.tsx b/apps/web/src/List.tsx',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/apps/web/src/List.tsx',
      '+export const List = 1;',
    ].join('\n');
    expect(patchScope(patch)).toEqual({
      files: [{ path: 'apps/api/src/Orders.cs', add: 2, del: 1 }, { path: 'apps/web/src/List.tsx', add: 1, del: 0 }],
      areas: ['api', 'web'],
      add: 3,
      del: 1,
    });
  });

  it('a monorepo app or package by its name, otherwise the top folder', () => {
    expect(areaOf('packages/ui/src/Table.tsx')).toBe('ui');
    expect(areaOf('src/domains/portal/x.ts')).toBe('src');
    expect(areaOf('apps/README.md')).toBe('apps');
    expect(areaOf('package.json')).toBe('(raíz)');
  });
});
