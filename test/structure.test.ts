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


// Each file's relative imports, as the layer they land in (apps/<app> for
// an app), and whether they bring only types.
function imports(file: string): Array<{ spec: string; to: string; typeOnly: boolean }> {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(import type [^;]*?from|from|import\(|vi\.mock\()\s*'(\.{1,2}\/[^']+)'/g)].map(([, how, spec]) => {
    const to = relative(SRC, resolve(dirname(file), spec)).split('/');
    return { spec, to: to[0] === 'apps' ? `apps/${to[1]}` : to[0], typeOnly: how.startsWith('import type') };
  });
}

const crossings = (from: string, forbidden: string[], typesAllowed = false) =>
  files(join(SRC, from)).flatMap((file) =>
    imports(file)
      .filter((i) => forbidden.some((f) => i.to === f || i.to.startsWith(`${f}/`)) && !(typesAllowed && i.typeOnly))
      .map((i) => `${relative(SRC, file)} → ${i.spec}`));

describe('the layers of src/', () => {
  it('platform/ imports no domain and no app', () => {
    expect(crossings('platform', ['domains', 'apps'])).toEqual([]);
  });

  it('domains/ import no app', () => {
    expect(crossings('domains', ['apps'])).toEqual([]);
  });

  // What runs on the code (git, docker, the dev servers) goes through
  // platform/host (#235, stage 4): only ronin's own processes start there
  // directly — `claude -p`, its workers, and `gh`, which talks to GitHub
  // from the central node.
  it('only platform/host and ronin\'s own launchers start processes', () => {
    const allowed = ['platform/host/host.ts', 'platform/claude/claude-runner.ts', 'platform/workers/worker-launch.ts', 'platform/github/github.ts'];
    const starting = files(SRC)
      .filter((file) => !/\.test\.tsx?$/.test(file) && /from 'node:child_process'/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
      .filter((file) => !allowed.includes(file));
    expect(starting).toEqual([]);
  });

  // The web apps run in the browser: from the server they take only the
  // types of its routes, and share their React pieces through ui/.
  it('ui/ imports nothing of the server', () => {
    expect(crossings('ui', ['apps', 'domains', 'platform'], true)).toEqual([]);
  });

  it('the web apps take only types from the server', () => {
    for (const app of ['dashboard', 'portal']) expect(crossings(`apps/${app}/src`, ['domains', 'platform', 'apps/api'], true)).toEqual([]);
  });
});
