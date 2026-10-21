import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The layers of src/ (docs/ARCHITECTURE.md, «Estructura del código»): the
// dependencies go one way, apps → domains → platform. Checked on every
// relative import, tests included, so a shortcut back fails here instead of
// growing quietly.

const SRC = resolve(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'vendor' ? [] : files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const layer = (path: string) => relative(SRC, path).split('/')[0];

// Each file's relative imports, as the layer they land in.
function imports(file: string): Array<{ spec: string; to: string }> {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from|import\(|vi\.mock\()\s*'(\.{1,2}\/[^']+)'/g)].map(([, spec]) => ({ spec, to: layer(resolve(dirname(file), spec)) }));
}

const crossings = (from: string, forbidden: string[]) =>
  files(join(SRC, from)).flatMap((file) => imports(file).filter((i) => forbidden.includes(i.to)).map((i) => `${relative(SRC, file)} → ${i.spec}`));

describe('the layers of src/', () => {
  it('platform/ imports no domain and no app', () => {
    expect(crossings('platform', ['domains', 'apps'])).toEqual([]);
  });

  it('domains/ import no app', () => {
    expect(crossings('domains', ['apps'])).toEqual([]);
  });
});
