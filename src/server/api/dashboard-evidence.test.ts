import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../core/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'acme/product' }) }));

import { publishEvidence } from '../../app/evidence-store.js';
import { readEvidence } from './dashboard-evidence.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let base: string;
let clone: string;
let other: string;
let mainSha: string;
let sha: string;
const entry = () => ({ productRepo: 'acme/product', productRepoPath: clone });

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-dashboard-evidence-'));
  const remote = join(base, 'remote.git');
  clone = join(base, 'clone');
  other = join(base, 'other');
  git(base, 'init', '-q', '--bare', remote);
  git(base, 'clone', '-q', remote, clone);
  for (const key of ['user.email', 'user.name']) git(clone, 'config', key, 'r');
  await writeFile(join(clone, 'logo.png'), 'not evidence');
  await writeFile(join(clone, '.env'), 'SECRET=1');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'app');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  mainSha = git(clone, 'rev-parse', 'HEAD');
  await writeFile(join(base, 'shot.png'), 'PNG');
  await writeFile(join(base, 'notes.txt'), 'txt');
  sha = await publishEvidence(clone, [{ src: join(base, 'shot.png'), path: 'backoffice/run-1/F-0001/antes 1.png' }, { src: join(base, 'notes.txt'), path: 'backoffice/notes.txt' }], 'run 1');
  // A clone that never published anything: it only has the branch after a fetch.
  git(base, 'clone', '-q', remote, other);
});
afterAll(() => rm(base, { recursive: true, force: true }));

describe('readEvidence', () => {
  it('reads an image of the evidence branch from the clone', async () => {
    const image = await readEvidence(entry(), sha, ['backoffice', 'run-1', 'F-0001', 'antes 1.png']);
    expect(image?.type).toBe('image/png');
    expect(image?.data.toString()).toBe('PNG');
  });

  it('fetches the branch when the sha is not in the clone yet', async () => {
    const image = await readEvidence({ productRepo: 'acme/product', productRepoPath: other }, sha, ['backoffice', 'run-1', 'F-0001', 'antes 1.png']);
    expect(image?.data.toString()).toBe('PNG');
  });

  it('serves nothing that is not an image of the evidence branch', async () => {
    expect(await readEvidence(entry(), sha, ['backoffice', 'notes.txt'])).toBeNull();
    expect(await readEvidence(entry(), mainSha, ['logo.png'])).toBeNull();
    expect(await readEvidence(entry(), mainSha, ['.env'])).toBeNull();
    expect(await readEvidence(entry(), sha, ['backoffice', '..', 'x.png'])).toBeNull();
    expect(await readEvidence(entry(), sha, ['nada.png'])).toBeNull();
    expect(await readEvidence(entry(), 'HEAD', ['logo.png'])).toBeNull();
    expect(await readEvidence(entry(), '--help', ['logo.png'])).toBeNull();
  });
});
