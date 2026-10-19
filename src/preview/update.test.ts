import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../core/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../core/config.js', () => ({ config: { githubLogin: 'ronin-agent', previewReservationsDir: '/nonexistent', previewPrepareData: false } }));

let root: string;
vi.mock('../core/repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'acme/product', productRepoPath: join(root, 'repo'), worktreeBasePath: join(root, 'wt') }),
}));
const appRerun = vi.fn();
vi.mock('../app/runtime.js', async (importOriginal) => ({ ...(await importOriginal<object>()), appRerun: (...args: unknown[]) => appRerun(...args) }));

const { planInPlaceUpdate, renderPreviewUpdated, updatePreview } = await import('./preview.js');

const manifest = (steps: object[]) => JSON.stringify({
  apps: {
    web: {
      path: 'apps/web',
      steps,
      baseUrl: 'http://127.0.0.1:{{port.web}}',
      users: [{ role: 'Admin', username: 'admin@example.com', password: 'password' }],
      login: [{ goto: '/login' }],
    },
  },
}, null, 2);

const install = { name: 'dependencias', run: 'pnpm install', rerunOn: ['pnpm-lock.yaml'] };
const migrate = { name: 'migraciones', run: 'pnpm migrate', rerunOn: ['apps/api/migrations/**'] };
const web = { name: 'web', start: 'vite --port {{port.web}}' };
const MANIFEST = manifest([install, migrate, web]);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

async function commit(files: Record<string, string>, message: string): Promise<string> {
  const repo = join(root, 'repo');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
}

// The PR's new head, pushed where planInPlaceUpdate fetches it from.
async function pushPr(files: Record<string, string>): Promise<string> {
  const sha = await commit(files, 'pr');
  git(join(root, 'repo'), 'push', '-q', 'origin', `${sha}:refs/pull/7/head`);
  return sha;
}

let first: string;
const previewDir = () => join(root, 'wt', 'preview-pr-7');
const statePath = () => join(previewDir(), '.ronin-app', 'preview.json');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'preview-update-'));
  appRerun.mockReset().mockResolvedValue({});
  git(root, 'init', '-q', '--bare', 'origin.git');
  git(root, 'init', '-q', '-b', 'main', 'repo');
  git(join(root, 'repo'), 'remote', 'add', 'origin', join(root, 'origin.git'));
  first = await commit({ 'ronin.app.json': MANIFEST, 'pnpm-lock.yaml': 'a', 'apps/web/page.tsx': 'a' }, 'base');
  git(join(root, 'repo'), 'push', '-q', 'origin', 'main');
  git(join(root, 'repo'), 'worktree', 'add', '-q', '--detach', previewDir(), first);
  await mkdir(join(previewDir(), '.ronin-app'), { recursive: true });
  await writeFile(join(previewDir(), '.ronin-app', 'preview-manifest.json'), MANIFEST);
  await writeFile(statePath(), JSON.stringify({ prNumber: 7, appName: 'web', sha: first, url: 'https://h:20001', startedAt: '2026-10-19T10:00:00.000Z' }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const head = (sha: string) => ({ baseRefName: 'main', headRefOid: sha, title: 't', body: '', state: 'OPEN', isCrossRepository: false }) as never;

describe('planInPlaceUpdate', () => {
  it('moves the checkout and picks the steps whose rerunOn the new commit touches', async () => {
    const sha = await pushPr({ 'pnpm-lock.yaml': 'b', 'apps/web/page.tsx': 'b' });
    const plan = await planInPlaceUpdate(7, { sha: first, appName: 'web' }, head(sha));
    expect(plan).toEqual({ app: expect.anything(), steps: [install] });
    expect(git(previewDir(), 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('runs no step when only code the dev servers reload changed', async () => {
    const sha = await pushPr({ 'apps/web/page.tsx': 'b' });
    expect(await planInPlaceUpdate(7, { sha: first, appName: 'web' }, head(sha))).toEqual({ app: expect.anything(), steps: [] });
  });

  it('rebuilds when the PR changes the manifest it came up with', async () => {
    const sha = await pushPr({ 'ronin.app.json': manifest([install, web]) });
    expect(await planInPlaceUpdate(7, { sha: first, appName: 'web' }, head(sha))).toEqual({ reason: 'cambió el ronin.app.json' });
  });

  it('rebuilds when no step declares rerunOn', async () => {
    const bare = manifest([{ name: 'dependencias', run: 'pnpm install' }, web]);
    await writeFile(join(previewDir(), '.ronin-app', 'preview-manifest.json'), bare);
    const sha = await pushPr({ 'ronin.app.json': bare });
    git(join(root, 'repo'), 'push', '-q', 'origin', `${sha}:main`);
    expect(await planInPlaceUpdate(7, { sha: first, appName: 'web' }, head(sha))).toEqual({ reason: expect.stringContaining('rerunOn') });
  });

  it('still compares after a force-push that rewrote the history', async () => {
    const repo = join(root, 'repo');
    git(repo, 'checkout', '-q', '-b', 'pr', first);
    const rewritten = await commit({ 'apps/api/migrations/2-x.sql': 'x' }, 'rewritten');
    git(repo, 'push', '-q', '--force', 'origin', `${rewritten}:refs/pull/7/head`);
    expect(await planInPlaceUpdate(7, { sha: first, appName: 'web' }, head(rewritten))).toEqual({ app: expect.anything(), steps: [migrate] });
  });
});

describe('updatePreview', () => {
  it('reruns the steps in place and keeps the URL and the TTL count', async () => {
    const sha = await pushPr({ 'pnpm-lock.yaml': 'b' });
    const update = await updatePreview(7, head(sha));
    expect(update).toEqual({ kind: 'in-place', from: first, sha, url: 'https://h:20001', rerun: ['dependencias'] });
    expect(appRerun).toHaveBeenCalledWith(previewDir(), expect.anything(), [install]);
    const state = JSON.parse(await readFile(statePath(), 'utf8'));
    expect(state).toMatchObject({ sha, startedAt: '2026-10-19T10:00:00.000Z' });
    expect(state.updating).toBeUndefined();
    expect(state.updatedAt).toEqual(expect.any(String));
  });

  it('does nothing when the preview is already on the head', async () => {
    expect(await updatePreview(7, head(first))).toEqual({ kind: 'current' });
    expect(appRerun).not.toHaveBeenCalled();
  });

  it('is null for a PR without a preview up', async () => {
    await rm(statePath());
    expect(await updatePreview(7, head(first))).toBeNull();
  });
});

describe('renderPreviewUpdated', () => {
  it('names the commits and what ran again', () => {
    const body = renderPreviewUpdated({ kind: 'in-place', from: 'aaaaaaa111', sha: 'bbbbbbb222', url: 'https://h:1', rerun: ['dependencias', 'api'] });
    expect(body).toContain('`aaaaaaa` → `bbbbbbb`');
    expect(body).toContain('Volví a correr: *dependencias*, *api*.');
  });

  it('says when no step had to run', () => {
    expect(renderPreviewUpdated({ kind: 'in-place', from: 'a', sha: 'b', url: 'u', rerun: [] })).toContain('los dev servers tomaron el cambio solos');
  });

  it('gives the reason and the URL of a rebuild', () => {
    const body = renderPreviewUpdated({ kind: 'rebuilt', from: 'aaaaaaa111', reason: 'cambió el ronin.app.json', result: { appName: 'web', sha: 'bbbbbbb222', url: 'https://h:2', users: [] } });
    expect(body).toContain('levantándola de cero, porque cambió el ronin.app.json: **https://h:2**');
  });
});
