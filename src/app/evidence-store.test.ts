import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../core/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart' }) }));

import { EVIDENCE_BRANCH, evidenceUrl, publishEvidence } from './evidence-store.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let base: string;
let remote: string;
let clone: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-evidence-test-'));
  remote = join(base, 'remote.git');
  clone = join(base, 'clone');
  git(base, 'init', '-q', '--bare', remote);
  git(base, 'clone', '-q', remote, clone);
  git(clone, 'config', 'user.email', 'r@x');
  git(clone, 'config', 'user.name', 'r');
  await writeFile(join(clone, 'app.txt'), 'app');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'app');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('publishEvidence', () => {
  it('creates the orphan branch, then adds on top, without touching the checkout', async () => {
    await writeFile(join(base, 'a.png'), 'A');
    const first = await publishEvidence(clone, [{ src: join(base, 'a.png'), path: 'backoffice/run-1/F-0001/antes-1.png' }], 'run 1');
    expect(git(remote, 'rev-parse', EVIDENCE_BRANCH)).toBe(first);
    expect(git(remote, 'rev-list', '--count', EVIDENCE_BRANCH)).toBe('1');
    expect(git(remote, 'show', `${first}:backoffice/run-1/F-0001/antes-1.png`)).toBe('A');

    await writeFile(join(base, 'b.png'), 'B');
    const second = await publishEvidence(clone, [{ src: join(base, 'b.png'), path: 'backoffice/run-2/F-0002/despues.png' }], 'run 2');
    expect(git(remote, 'rev-parse', `${second}^`)).toBe(first);
    expect(git(remote, 'ls-tree', '-r', '--name-only', second).split('\n')).toEqual(['backoffice/run-1/F-0001/antes-1.png', 'backoffice/run-2/F-0002/despues.png']);
    // Unrelated to main, and the checkout is as it was.
    expect(() => git(remote, 'merge-base', 'main', second)).toThrow();
    expect(git(clone, 'status', '--porcelain')).toBe('');
  });
});

describe('evidenceUrl', () => {
  it('points at the commit, so the link never moves', () => {
    expect(evidenceUrl('abc123', 'backoffice/2026-10-12-7/F-0003/antes 1.png')).toBe(
      'https://github.com/redmotos/shoppingcart/blob/abc123/backoffice/2026-10-12-7/F-0003/antes%201.png?raw=true',
    );
  });
});
