import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APP_MANIFEST_FILE } from '../app/manifest.js';
import { config } from '../core/config.js';
import { createRelease, listMergedPrs, listReleases, type Release } from '../core/github.js';
import { tryLockResource, unlockResource } from '../core/locks.js';
import { log } from '../core/logger.js';
import { activeRepo } from '../core/repo-context.js';
import { errorLine, listRequests, noteEvent, type PortalRequest } from '../portal/requests.js';
import { addDeploy, listDeploys, type DeployRecord } from './store.js';

// A deploy (#158) is a GitHub release: ronin publishes it on the tag someone
// wrote, and the repo's own workflow (on the tag, or on the release) does
// the rest. It carries everything merged on the repo's branch, or — in a
// repo with deploy.selective — only the PRs someone picked, cherry-picked
// onto the last release.
//
// Nothing here knows about the dashboard: these run inside withActiveRepo,
// and whoever calls them (the dashboard today, the portal's own deploys
// later) only says what goes in.

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd = activeRepo().productRepoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export class DeployError extends Error {
  constructor(message: string, readonly plan?: Plan) {
    super(message);
  }
}

export interface PendingChange {
  // The commit on the branch: a squash-merged PR is one.
  sha: string;
  subject: string;
  pr: number | null;
  files: string[];
  // The apps of ronin.app.json it touches.
  apps: string[];
  // The portal requests whose PR it is.
  pedidos: number[];
}

export interface Pending {
  branch: string;
  head: string;
  // The last release of the same kind (a pre-release, or a full one). Null:
  // the repo has none yet, so there's nothing to compare with.
  base: { tag: string; sha: string } | null;
  // Oldest first, as they merged.
  changes: PendingChange[];
}

export type Problem =
  | { kind: 'tag-invalid' }
  | { kind: 'tag-exists' }
  | { kind: 'nothing' }
  | { kind: 'not-selective' }
  | { kind: 'no-base' }
  | { kind: 'unknown-pr'; pr: number }
  // A picked PR that doesn't apply onto the last release: the files that
  // clash, and the PRs not picked that changed them before it.
  | { kind: 'conflict'; pr: number | null; sha: string; files: string[]; needs: number[] };

export interface ReleaseRequest {
  tag: string;
  // The PRs to carry, or everything on the branch.
  prs: number[] | 'all';
  prerelease?: boolean;
}

export interface Plan {
  repo: string;
  tag: string;
  prerelease: boolean;
  mode: 'all' | 'pick';
  branch: string;
  base: Pending['base'];
  // The commit the tag goes on: the branch's head, or the cherry-picks'.
  // Null while there's a problem.
  target: string | null;
  changes: PendingChange[];
  apps: string[];
  notes: string;
  problems: Problem[];
  // What it was planned on: publishing refuses if that moved since.
  fingerprint: string;
}

// The branch ronin works from (worktreeBaseRef, "origin/odoo-main").
export const deployBranch = () => (activeRepo().worktreeBaseRef ?? config.worktreeBaseRef).replace(/^origin\//, '');

// What git allows in a tag, minus what would read badly in a URL or a shell.
export const validTag = (tag: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(tag) && !tag.includes('..') && !tag.endsWith('.lock') && !tag.endsWith('.');

async function tagExists(tag: string): Promise<boolean> {
  return (await git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])).trim().length > 0;
}

// The newest published release of the kind: a pre-release compares with the
// last pre-release, a full one with the last full one.
function lastRelease(all: Release[], prerelease: boolean) {
  const releases = all.filter((r) => !r.isDraft && r.isPrerelease === prerelease);
  return releases.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0] ?? null;
}

// What the pending changes come from: the checkout, fetched, and GitHub's
// releases and merged PRs, with the portal's requests. Read all at once, and
// once for both kinds of release (and the dashboard's card of releases).
export interface RepoRead {
  releases: Release[];
  merged: Array<{ number: number; title: string; mergeCommit: string }>;
  requests: PortalRequest[];
}

export async function readRepo(): Promise<RepoRead> {
  const [, releases, merged, requests] = await Promise.all([
    git(['fetch', '--quiet', '--tags', '--force', 'origin']),
    listReleases(),
    listMergedPrs(deployBranch()),
    listRequests(),
  ]);
  return { releases, merged, requests };
}

// app → its directory, from ronin.app.json at `ref`. Read loosely: a deploy
// only uses it to say which apps a change touches.
async function appPaths(ref: string): Promise<Record<string, string>> {
  try {
    const manifest = JSON.parse(await git(['show', `${ref}:${APP_MANIFEST_FILE}`])) as { apps?: Record<string, { path?: unknown }> };
    return Object.fromEntries(Object.entries(manifest.apps ?? {}).flatMap(([name, app]) => (typeof app?.path === 'string' ? [[name, app.path.replace(/^\.\/|\/$/g, '')]] : [])));
  } catch {
    return {};
  }
}

export const appsOf = (files: string[], paths: Record<string, string>) =>
  Object.keys(paths).filter((app) => files.some((f) => paths[app] === '' || f === paths[app] || f.startsWith(`${paths[app]}/`)));

// A squash merge ends in "(#123)"; a merge commit starts "Merge pull request #123".
export const prOf = (subject: string): number | null => Number(/\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? /^Merge pull request #(\d+)/.exec(subject)?.[1]) || null;

// The PRs a release of picked PRs carried, and the ones of the picked
// releases it was made on, back to a release cut from the branch: those
// are out even though their commits on the branch aren't in the release.
async function carriedBy(tag: string): Promise<Set<number>> {
  const records = await listDeploys(activeRepo().productRepo);
  const carried = new Set<number>();
  for (let record = records.find((d) => d.tag === tag); record?.mode === 'pick'; record = records.find((d) => d.tag === record!.base)) {
    for (const c of record.changes) if (c.pr) carried.add(c.pr);
    if (!record.base) break;
  }
  return carried;
}

// What the branch has that the last release doesn't, one change per PR:
// the branch's own commits (first parent) since the release's place on it —
// a PR's merge commit, or its squash — never the PR's inner commits. Out
// already: what the release has by patch (git cherry: a PR cherry-picked by
// hand), and what a release of picked PRs carried (its record).
export async function pendingChanges(opts: { prerelease?: boolean } = {}, read?: RepoRead): Promise<Pending> {
  const { releases, merged: mergedPrs, requests: allRequests } = read ?? (await readRepo());
  const branch = deployBranch();
  const release = lastRelease(releases, Boolean(opts.prerelease));
  const [head, baseSha] = (await Promise.all([
    git(['rev-parse', `origin/${branch}`]),
    release ? git(['rev-parse', `refs/tags/${release.tagName}^{commit}`]) : '',
  ])).map((out) => out.trim());
  if (!release) return { branch, head, base: null, changes: [] };
  const base = { tag: release.tagName, sha: baseSha };
  // Where the release left the branch: itself, or what its cherry-picks went onto.
  const from = (await git(['merge-base', base.sha, head])).trim();
  // The branch's own commits, each with its subject and the files it changed
  // against its first parent (a merge commit: what its PR brought).
  const [log, cherry, carried, paths] = await Promise.all([
    git(['log', '--first-parent', '--reverse', '--diff-merges=first-parent', '--name-only', '--format=%x00%H%x00%s', `${from}..${head}`]),
    git(['cherry', base.sha, head]),
    carriedBy(base.tag),
    appPaths(head),
  ]);
  const parts = log.split('\0').slice(1);
  const commits: Array<{ sha: string; subject: string; files: string[] }> = [];
  for (let i = 0; i < parts.length; i += 2) {
    const [subject, ...files] = parts[i + 1].split('\n');
    commits.push({ sha: parts[i], subject: subject.trim(), files: files.filter(Boolean) });
  }
  const same = new Set(cherry.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2)));
  const merged = new Map(mergedPrs.map((p) => [p.mergeCommit, p]));
  const repo = activeRepo().productRepo;
  const requests = allRequests.filter((r) => r.repo === repo && r.pr);
  const changes: PendingChange[] = [];
  for (const { sha, subject, files } of commits) {
    if (same.has(sha)) continue;
    const known = merged.get(sha);
    const pr = known?.number ?? prOf(subject);
    if (pr && carried.has(pr)) continue;
    changes.push({ sha, subject: known && !subject.includes(`#${pr}`) ? `${known.title} (#${pr})` : subject, pr, files, apps: appsOf(files, paths), pedidos: pr ? requests.filter((r) => r.pr === pr).map((r) => r.number) : [] });
  }
  return { branch, head, base, changes };
}

// Who the cherry-picks say committed them; each keeps its author.
const COMMITTER = () => ['-c', `user.name=${config.githubLogin}`, '-c', `user.email=${config.githubLogin}@users.noreply.github.com`];

// The picked changes, in the order they merged, onto the last release, in a
// throwaway worktree (its name isn't a ronin-<n>-… one, so the tick's sweep
// leaves it alone). The commit stays in the repo's objects once the
// worktree goes, for publishRelease to push.
async function cherryPick(pending: Pending, picked: PendingChange[], tag: string): Promise<{ sha: string } | { conflict: Extract<Problem, { kind: 'conflict' }> }> {
  const dir = join(activeRepo().worktreeBasePath, `.deploy-${tag}-${process.pid}-${Date.now()}`);
  await mkdir(activeRepo().worktreeBasePath, { recursive: true });
  await git(['worktree', 'add', '--quiet', '--detach', dir, pending.base!.sha]);
  try {
    for (const change of picked) {
      // A merge commit (a repo that doesn't squash) goes in as its first parent's diff.
      const merge = (await git(['rev-list', '--parents', '-n', '1', change.sha])).trim().split(' ').length > 2;
      try {
        await git([...COMMITTER(), 'cherry-pick', ...(merge ? ['-m', '1'] : []), change.sha], dir);
      } catch (error) {
        const files = (await git(['diff', '--name-only', '--diff-filter=U'], dir).catch(() => '')).split('\n').filter(Boolean);
        // Already on the release by another commit: nothing to add.
        if (!files.length && /empty/i.test(String((error as { stderr?: string }).stderr ?? error))) {
          await git(['cherry-pick', '--skip'], dir);
          continue;
        }
        await git(['cherry-pick', '--abort'], dir).catch(() => {});
        const at = pending.changes.indexOf(change);
        const needs = pending.changes
          .filter((c, i) => i < at && !picked.includes(c) && c.pr !== null && c.files.some((f) => files.includes(f)))
          .map((c) => c.pr!);
        return { conflict: { kind: 'conflict', pr: change.pr, sha: change.sha, files, needs } };
      }
    }
    return { sha: (await git(['rev-parse', 'HEAD'], dir)).trim() };
  } finally {
    await git(['worktree', 'remove', '--force', dir]).catch(() => rm(dir, { recursive: true, force: true }));
  }
}

export function releaseNotes(changes: PendingChange[]): string {
  if (!changes.length) return '';
  return ['## Qué entra', '', ...changes.map((c) => `- ${c.subject}${c.pedidos.length ? ` · ${c.pedidos.map((n) => `pedido P-${n}`).join(', ')}` : ''}`)].join('\n');
}

export function problemText(problem: Problem): string {
  switch (problem.kind) {
    case 'tag-invalid': return 'El tag solo puede tener letras, números, puntos, guiones y guiones bajos.';
    case 'tag-exists': return 'Ese tag ya existe: escribe uno nuevo.';
    case 'nothing': return 'No hay nada para desplegar.';
    case 'not-selective': return 'Este repo no tiene habilitado desplegar solo algunos PRs (deploy.selective en repos.json).';
    case 'no-base': return 'El repo no tiene un release anterior sobre el cual aplicar solo algunos PRs.';
    case 'unknown-pr': return `El PR #${problem.pr} no está entre lo mergeado sin desplegar.`;
    case 'conflict': return `${problem.pr ? `El PR #${problem.pr}` : `El commit ${problem.sha.slice(0, 7)}`} no se aplica sobre el último release${problem.files.length ? ` (${problem.files.join(', ')})` : ''}${problem.needs.length ? `: elige también ${problem.needs.map((n) => `#${n}`).join(', ')}` : ''}.`;
  }
}

// What publishing would do, without publishing: the tag checked, what goes
// in, and — for picked PRs — the cherry-picks tried for real.
export async function planRelease(req: ReleaseRequest): Promise<Plan> {
  const entry = activeRepo();
  if (!entry.deploy) throw new DeployError(`${entry.productRepo} no tiene deploy en repos.json`);
  const prerelease = Boolean(req.prerelease);
  if (prerelease && !entry.deploy.prerelease) throw new DeployError(`${entry.productRepo} no usa pre-releases (deploy.prerelease en repos.json)`);
  const pending = await pendingChanges({ prerelease });
  const tag = req.tag.trim();
  const problems: Problem[] = [];
  if (!validTag(tag)) problems.push({ kind: 'tag-invalid' });
  else if (await tagExists(tag)) problems.push({ kind: 'tag-exists' });
  const mode = req.prs === 'all' ? 'all' : 'pick';
  let changes: PendingChange[];
  let target: string | null = null;
  if (req.prs === 'all') {
    changes = pending.changes;
    // With no release before, everything on the branch goes.
    if (pending.base && !changes.length) problems.push({ kind: 'nothing' });
    target = pending.head;
  } else {
    const wanted = new Set(req.prs);
    changes = pending.changes.filter((c) => c.pr !== null && wanted.has(c.pr));
    if (!entry.deploy.selective) problems.push({ kind: 'not-selective' });
    else if (!pending.base) problems.push({ kind: 'no-base' });
    for (const pr of wanted) if (!changes.some((c) => c.pr === pr)) problems.push({ kind: 'unknown-pr', pr });
    if (!wanted.size) problems.push({ kind: 'nothing' });
    // The tag's own problems don't stop the try: the conflicts are worth seeing anyway.
    if (!problems.some((p) => p.kind !== 'tag-invalid' && p.kind !== 'tag-exists')) {
      const picked = await cherryPick(pending, changes, validTag(tag) ? tag : 'tag');
      if ('conflict' in picked) problems.push(picked.conflict);
      else target = picked.sha;
    }
  }
  if (problems.length) target = null;
  return {
    repo: entry.productRepo,
    tag,
    prerelease,
    mode,
    branch: pending.branch,
    base: pending.base,
    target,
    changes,
    apps: [...new Set(changes.flatMap((c) => c.apps))],
    notes: releaseNotes(changes),
    problems,
    fingerprint: `${mode}:${pending.base?.sha ?? ''}:${mode === 'all' ? pending.head : changes.map((c) => c.sha).join(',')}`,
  };
}

export interface PublishRequest extends ReleaseRequest {
  title?: string;
  notes?: string;
  // Who asked for it (a GitHub login), for the record.
  by: string;
  // The plan's, as it was shown: refuses if what goes in changed since.
  fingerprint?: string;
}

// One release at a time per repo: two at once would compare with the same
// last release.
const PUBLISH_RESOURCE = 'deploy-publish';

// Plans again (the branch may have moved), pushes the tag and creates the
// release; the repo's workflow starts from there, and followDeploys
// follows it.
export async function publishRelease(req: PublishRequest): Promise<DeployRecord> {
  if (!(await tryLockResource(PUBLISH_RESOURCE))) throw new DeployError('Ya se está publicando otro despliegue de este repo: espera a que termine.');
  try {
    const plan = await planRelease(req);
    if (plan.problems.length) throw new DeployError(problemText(plan.problems[0]), plan);
    if (req.fingerprint && req.fingerprint !== plan.fingerprint) {
      throw new DeployError('Lo que entra cambió desde que lo viste (se mergeó algo o salió otro release): revísalo de nuevo.', plan);
    }
    await git(['push', '--quiet', 'origin', `${plan.target}:refs/tags/${plan.tag}`]);
    const record: DeployRecord = {
      repo: plan.repo,
      tag: plan.tag,
      prerelease: plan.prerelease,
      mode: plan.mode,
      base: plan.base?.tag ?? null,
      sha: plan.target!,
      url: '',
      changes: plan.changes.map((c) => ({ pr: c.pr, subject: c.subject })),
      pedidos: [...new Set(plan.changes.flatMap((c) => c.pedidos))],
      by: req.by,
      at: new Date().toISOString(),
      state: 'running',
    };
    // The tag is up: a workflow on tags may be deploying already, so the
    // record is kept even if the release fails.
    try {
      record.url = await createRelease({ tag: plan.tag, title: req.title?.trim() || plan.tag, notes: req.notes?.trim() || plan.notes || plan.tag, prerelease: plan.prerelease });
    } catch (error) {
      record.releaseError = errorLine(error);
    }
    await addDeploy(record);
    log.info(`deploy: ${req.by} publicó ${plan.tag} en ${plan.repo} (${plan.mode === 'all' ? 'todo' : 'PRs elegidos'}, ${plan.changes.length} cambios)`);
    for (const n of record.pedidos) {
      await noteEvent(n, { kind: 'deploy', tag: plan.tag, state: 'published', prerelease: plan.prerelease }).catch((error) => log.error(`deploy: no se pudo anotar ${plan.tag} en el pedido P-${n}`, error));
    }
    if (record.releaseError) throw new DeployError(`Se subió el tag ${plan.tag}, pero no se pudo crear el release: ${record.releaseError}`, plan);
    return record;
  } finally {
    await unlockResource(PUBLISH_RESOURCE);
  }
}
