import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../core/logger.js';
import { activeRepo } from '../core/repo-context.js';

const execFileAsync = promisify(execFile);

// Screenshots for the team — the exploration's before/after, the mockup of a
// /spec — live in an orphan branch of the product repo, never merged: only
// whoever can read the repo sees them, nothing outside GitHub is involved,
// and main's history stays free of images. See docs/DESIGN.md §11.5.
//
// Each publish is one commit on top of the branch, built with plumbing
// against a throwaway index, so it needs no worktree and never touches the
// checkout it runs from. Links point at that commit's sha, so they never
// move or break.

export const EVIDENCE_BRANCH = 'ronin/evidence';
const REMOTE_REF = `refs/remotes/origin/${EVIDENCE_BRANCH}`;

export interface EvidenceFile {
  // The local file.
  src: string;
  // Where it goes inside the branch, e.g. "backoffice/2026-10-12-7/F-0003/antes-1.png".
  path: string;
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

// The image as GitHub serves it to someone logged in with access to the
// repo; it renders inline in markdown (files, PR bodies, comments).
export function evidenceUrl(sha: string, path: string, repo = activeRepo().productRepo): string {
  return `https://github.com/${repo}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}?raw=true`;
}

async function commitOnTop(repoDir: string, files: EvidenceFile[], message: string): Promise<string> {
  await git(repoDir, ['fetch', 'origin', `+refs/heads/${EVIDENCE_BRANCH}:${REMOTE_REF}`]).catch(() => {
    // First publish: the branch doesn't exist yet.
  });
  const parent = await git(repoDir, ['rev-parse', '--verify', '-q', `${REMOTE_REF}^{commit}`]).catch(() => undefined);
  const indexDir = await mkdtemp(join(tmpdir(), 'ronin-evidence-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, 'index') };
    await git(repoDir, parent ? ['read-tree', parent] : ['read-tree', '--empty'], env);
    for (const file of files) {
      const blob = await git(repoDir, ['hash-object', '-w', file.src]);
      await git(repoDir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`], env);
    }
    const tree = await git(repoDir, ['write-tree'], env);
    return await git(repoDir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

// Commits the files to the evidence branch and pushes; returns the commit's
// sha for evidenceUrl. Retries once if someone else pushed in between.
export async function publishEvidence(repoDir: string, files: EvidenceFile[], message: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const commit = await commitOnTop(repoDir, files, message);
    try {
      await git(repoDir, ['push', 'origin', `${commit}:refs/heads/${EVIDENCE_BRANCH}`]);
      return commit;
    } catch (error) {
      if (attempt >= 2) throw error;
      log.info(`evidencia: el push a ${EVIDENCE_BRANCH} fue rechazado, reintento sobre lo último`);
    }
  }
}
