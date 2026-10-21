import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname } from 'node:path';
import { EVIDENCE_BRANCH } from '../product-app/evidence-store.js';
import type { RepoEntry } from '../../platform/agents/repo-context.js';

const execFileAsync = promisify(execFile);

// The screenshots ronin publishes (exploration, prototypes, /spec mockups)
// as the dashboard shows them. Their GitHub links only load with a GitHub
// session, which an <img> on this page never carries, so they're read from
// the product repo's own clone instead: publishEvidence commits them there
// before pushing. Only images, only from commits on the evidence branch —
// nothing else of the repo leaves through here.

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const REMOTE_REF = `refs/remotes/origin/${EVIDENCE_BRANCH}`;
// A sha that isn't there yet (published from another clone) asks for a fetch,
// at most this often per repo.
const FETCH_EVERY_MS = 60_000;
const lastFetch = new Map<string, number>();

export interface EvidenceImage {
  type: string;
  data: Buffer;
}

async function onEvidenceBranch(dir: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', sha, REMOTE_REF], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

async function fetchEvidence(dir: string): Promise<void> {
  if (Date.now() - (lastFetch.get(dir) ?? 0) < FETCH_EVERY_MS) return;
  lastFetch.set(dir, Date.now());
  await execFileAsync('git', ['fetch', '-q', 'origin', `+refs/heads/${EVIDENCE_BRANCH}:${REMOTE_REF}`], { cwd: dir }).catch(() => {});
}

// Null for anything that isn't an image of the evidence branch.
export async function readEvidence(entry: RepoEntry, sha: string, segments: string[]): Promise<EvidenceImage | null> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
  if (!segments.length || segments.some((s) => !s || s === '.' || s === '..' || /[\\\0:]/.test(s))) return null;
  const path = segments.join('/');
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!type) return null;
  const dir = entry.productRepoPath;
  if (!(await onEvidenceBranch(dir, sha))) {
    await fetchEvidence(dir);
    if (!(await onEvidenceBranch(dir, sha))) return null;
  }
  try {
    const { stdout } = await execFileAsync('git', ['cat-file', 'blob', `${sha}:${path}`], { cwd: dir, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    return { type, data: stdout };
  } catch {
    return null;
  }
}
