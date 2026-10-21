import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { activeRepo } from '../../platform/agents/repo-context.js';
import { removeWorktreeDir } from '../../platform/git/worktree.js';
import { runAgentTask } from '../../platform/agents/agent-task.js';
import { commandTask } from './prompts.js';
import type { PrHead } from '../../platform/github/github.js';
import { acquireLock, launchWorker } from '../../platform/workers/worker-launch.js';
import { log } from '../../platform/logger.js';

const execFileAsync = promisify(execFile);

// `/resolve-conflicts` on a PR: ronin merges the PR's base into its branch —
// the same commit GitHub's "Update branch" makes, never a rebase, so nobody's
// history is rewritten and nothing is force-pushed — and has an agent
// resolve whatever git couldn't. The merge, the checks on the agent's work,
// the commit and the push are all done here, by code; the agent only edits
// the conflicted files.

export interface ConflictsWorkerRequest {
  repo: string;
  prNumber: number;
  // The /resolve-conflicts comment, to answer in its own place.
  comment: { id: number; kind: 'issue' | 'review' };
}

export function launchConflictsWorker(request: ConflictsWorkerRequest): void {
  const pid = launchWorker('domains/commands/conflicts-worker', request);
  log.info(`conflictos: worker lanzado para el PR #${request.prNumber} (pid ${pid})`);
}

// Its own directory name, so sweepOrphanedWorktrees (ronin-<n>-…) never
// touches it, and a fix-comments-external on the same branch can't collide
// with it.
export function conflictsDirFor(prNumber: number): string {
  return join(activeRepo().worktreeBasePath, `conflicts-pr-${prNumber}`);
}

// One worker per PR at a time: two would merge and push over each other.
function lockPath(prNumber: number): string {
  return join(activeRepo().worktreeBasePath, `.conflicts-pr-${prNumber}.lock`);
}

export function acquireConflictsLock(prNumber: number): Promise<boolean> {
  return acquireLock(lockPath(prNumber));
}

export async function releaseConflictsLock(prNumber: number): Promise<void> {
  await rm(lockPath(prNumber), { force: true });
}

export interface AgentResolution {
  resuelto: boolean;
  // One line per conflicted file: what each side changed and what was kept.
  archivos: string[];
  // Choices a human should look at before merging.
  revisar: string[];
  // What was run to check the result, and how it went.
  verificacion: string;
  error?: string;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()) : [];
}

export function parseAgentResolution(raw: string): AgentResolution {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const error = typeof data.error === 'string' && data.error.trim() ? data.error.trim() : undefined;
  return {
    resuelto: data.resuelto === true && !error,
    archivos: strings(data.archivos),
    revisar: strings(data.revisar),
    verificacion: typeof data.verificacion === 'string' ? data.verificacion.trim() : '',
    ...(error ? { error } : {}),
  };
}

export type ConflictsOutcome =
  | { kind: 'up-to-date'; base: string }
  | { kind: 'merged-clean'; base: string; sha: string }
  | { kind: 'resolved'; base: string; sha: string; files: string[]; resolution: AgentResolution }
  | { kind: 'unresolved'; base: string; files: string[]; reason: string; resolution?: AgentResolution }
  | { kind: 'branch-moved'; base: string };

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function gitOk(dir: string, args: string[]): Promise<boolean> {
  return execFileAsync('git', args, { cwd: dir }).then(() => true, () => false);
}

async function unmergedFiles(dir: string): Promise<string[]> {
  return (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
}

// What has to be true before the merge commit is made — checked by code, not
// taken from the agent's word. Returns why not, or null when it can go.
export async function mergeNotReady(dir: string, files: string[]): Promise<string | null> {
  if (!(await gitOk(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']))) return 'el merge ya no está en curso en el checkout';
  const left = await unmergedFiles(dir);
  if (left.length > 0) return `quedaron archivos sin resolver: ${left.join(', ')}`;
  const markers = await Promise.all(files.map(async (f) => {
    const path = join(dir, f);
    if (!existsSync(path)) return null;
    return /^(<{7}|>{7})( |$)|^={7}$/m.test(await readFile(path, 'utf8')) ? f : null;
  }));
  const withMarkers = markers.filter((f): f is string => f !== null);
  if (withMarkers.length > 0) return `quedaron marcas de conflicto en ${withMarkers.join(', ')}`;
  if ((await git(dir, ['diff', '--name-only'])) !== '') return 'quedaron cambios sin agregar al merge';
  return null;
}

async function prepareCheckout(dir: string, head: string, base: string): Promise<void> {
  const repoPath = activeRepo().productRepoPath;
  await execFileAsync('git', ['fetch', 'origin', head, base], { cwd: repoPath });
  if (existsSync(dir)) await removeWorktreeDir(dir, 'resolveConflicts');
  await mkdir(activeRepo().worktreeBasePath, { recursive: true });
  // Detached, like ensureTrustedFixWorktree: the branch is often checked out
  // in the primary worktree by whoever is working on it.
  await execFileAsync('git', ['worktree', 'add', '--detach', dir, `origin/${head}`], { cwd: repoPath });
}

// Plain push, never forced: if someone pushed to the branch while this ran,
// it's rejected and they're asked to run the command again.
async function push(dir: string, head: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['push', 'origin', `HEAD:refs/heads/${head}`], { cwd: dir });
    return true;
  } catch (error) {
    const message = String((error as { stderr?: string }).stderr ?? error);
    if (/rejected|non-fast-forward|fetch first/i.test(message)) return false;
    throw error;
  }
}

export async function resolveConflicts(prNumber: number, pr: PrHead): Promise<ConflictsOutcome> {
  const base = pr.baseRefName;
  const head = pr.headRefName;
  const dir = conflictsDirFor(prNumber);
  await prepareCheckout(dir, head, base);
  try {
    if (await gitOk(dir, ['merge-base', '--is-ancestor', `origin/${base}`, 'HEAD'])) return { kind: 'up-to-date', base };

    const message = `Merge branch '${base}' into ${head}`;
    // --no-verify: the product repo's commit hooks (lint-staged and the like)
    // would check every file the base brings in, which is already reviewed
    // code, with tools this host may not have (dotnet csharpier on #849).
    if (await gitOk(dir, ['merge', '--no-ff', '--no-edit', '--no-verify', '-m', message, `origin/${base}`])) {
      if (!(await push(dir, head))) return { kind: 'branch-moved', base };
      return { kind: 'merged-clean', base, sha: await git(dir, ['rev-parse', 'HEAD']) };
    }

    const files = await unmergedFiles(dir);
    if (files.length === 0) throw new Error(`git merge origin/${base} falló sin dejar conflictos`);

    const outDir = join(activeRepo().worktreeBasePath, `.conflicts-pr-${prNumber}-out`);
    await mkdir(outDir, { recursive: true });
    const outputPath = join(outDir, 'result.json');
    await rm(outputPath, { force: true });
    await runAgentTask(commandTask({ type: 'resolve-conflicts', prNumber, checkoutDir: dir, outputPath, headRefName: head, baseRefName: base, title: pr.title, body: pr.body, conflictedFiles: files }));

    let resolution: AgentResolution;
    try {
      resolution = parseAgentResolution(await readFile(outputPath, 'utf8'));
    } catch {
      return { kind: 'unresolved', base, files, reason: 'el agente no dejó su resultado' };
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
    if (!resolution.resuelto) return { kind: 'unresolved', base, files, reason: resolution.error ?? 'el agente no pudo resolverlos', resolution };

    const notReady = await mergeNotReady(dir, files);
    if (notReady) return { kind: 'unresolved', base, files, reason: notReady, resolution };

    await git(dir, ['commit', '--no-edit', '--no-verify', '-m', message]);
    if (!(await push(dir, head))) return { kind: 'branch-moved', base };
    return { kind: 'resolved', base, sha: await git(dir, ['rev-parse', 'HEAD']), files, resolution };
  } finally {
    await removeWorktreeDir(dir, 'resolveConflicts').catch((error) => log.error(`conflictos PR #${prNumber}: no se pudo borrar el checkout`, error));
  }
}

function bullets(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join('\n');
}

export function renderConflictsStarting(base: string): string {
  return `🔀 Traigo \`${base}\` a este PR y resuelvo los conflictos. Te aviso acá cuando termine.`;
}

export function renderConflictsOutcome(outcome: ConflictsOutcome, login: string): string {
  const base = `\`${outcome.base}\``;
  switch (outcome.kind) {
    case 'up-to-date':
      return `Este PR ya tiene todo lo de ${base}: no hay conflictos que resolver.`;
    case 'merged-clean':
      return `✅ Traje ${base} al PR (${outcome.sha.slice(0, 7)}). No había conflictos que git no pudiera resolver solo.`;
    case 'branch-moved':
      return `⚠️ La rama del PR recibió commits mientras resolvía los conflictos, así que no subí nada. Volvé a pedirlo con \`@${login} /resolve-conflicts\`.`;
    case 'unresolved': {
      const parts = [
        `⚠️ No pude resolver los conflictos con ${base}: ${outcome.reason}. No subí nada.`,
        `Archivos en conflicto:\n${bullets(outcome.files.map((f) => `\`${f}\``))}`,
      ];
      if (outcome.resolution?.revisar.length) parts.push(`Lo que vi:\n${bullets(outcome.resolution.revisar)}`);
      return parts.join('\n\n');
    }
    case 'resolved': {
      const r = outcome.resolution;
      const parts = [
        `✅ Resolví los conflictos con ${base} y subí el merge (${outcome.sha.slice(0, 7)}).`,
        `**Cómo quedó cada archivo**\n${bullets(r.archivos.length ? r.archivos : outcome.files.map((f) => `\`${f}\``))}`,
      ];
      if (r.revisar.length) parts.push(`**Para revisar antes de mergear**\n${bullets(r.revisar)}`);
      if (r.verificacion) parts.push(`**Verificación:** ${r.verificacion}`);
      return parts.join('\n\n');
    }
  }
}

export function renderConflictsFailed(error: Error): string {
  return `❌ No pude resolver los conflictos: ${error.message.split('\n')[0].slice(0, 300)}. No subí nada.`;
}
