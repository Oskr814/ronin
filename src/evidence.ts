import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

// A dedicated checkout of ValerIA's own repo, always reset to main, used
// only for evidence commits — never the primary checkout, which a human
// (or Claude) might have on a feature branch mid-development. Sibling
// directory to ValerIA's own repo root (process.cwd() when `pnpm tick`
// runs, same assumption tick.ts already makes for templates/).
const EVIDENCE_CHECKOUT_DIR = join(process.cwd(), '..', 'valeria-evidence-checkout');

async function ensureEvidenceCheckout(): Promise<void> {
  if (existsSync(EVIDENCE_CHECKOUT_DIR)) {
    await execFileAsync('git', ['fetch', 'origin', 'main'], { cwd: EVIDENCE_CHECKOUT_DIR });
    await execFileAsync('git', ['reset', '--hard', 'origin/main'], { cwd: EVIDENCE_CHECKOUT_DIR });
    return;
  }
  await execFileAsync('git', ['clone', `git@github.com:${config.valeriaRepo}.git`, EVIDENCE_CHECKOUT_DIR]);
}

async function findScreenshots(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return findScreenshots(full);
      return entry.isFile() && /\.png$/i.test(entry.name) ? [full] : [];
    }),
  );
  return found.flat();
}

// Copies whatever Playwright screenshots exist in the given bmedical
// worktree into ValerIA's own repo (evidence/<issue>/<pr>/...) and pushes
// to main. Returns the committed paths (relative to the ValerIA repo root,
// for building raw URLs) — [] if there was nothing to publish, which is
// the normal case for a slice that didn't touch e2e-covered behavior.
export async function publishEvidence(issueNumber: number, prNumber: number, worktreeDir: string): Promise<string[]> {
  const resultsDir = join(worktreeDir, config.playwrightTestResultsDir);
  const screenshots = await findScreenshots(resultsDir);
  if (screenshots.length === 0) return [];

  await ensureEvidenceCheckout();
  // Subcarpeta por corrida — evita que una segunda publicación (p.ej.
  // disparada por @mención) pise los archivos de la anterior, o que no haya
  // nada que comitear si el contenido es byte-idéntico. Ver
  // docs/superpowers/specs/2026-07-29-mention-e2e-evidence-design.md.
  const destDir = `evidence/${issueNumber}/${prNumber}/${Date.now()}`;
  await mkdir(join(EVIDENCE_CHECKOUT_DIR, destDir), { recursive: true });

  const committed: string[] = [];
  for (const src of screenshots) {
    // Flattens Playwright's per-test subdirectory into the filename (e.g.
    // "login-page-smoke-test-chromium-test-finished-1.png") instead of
    // numbering them, so each screenshot is still identifiable on its own.
    const name = relative(resultsDir, src).replaceAll('/', '-');
    const destRelative = `${destDir}/${name}`;
    await copyFile(src, join(EVIDENCE_CHECKOUT_DIR, destRelative));
    committed.push(destRelative);
  }

  await execFileAsync('git', ['add', ...committed], { cwd: EVIDENCE_CHECKOUT_DIR });
  // -c user.name/user.email rather than relying on this checkout (or the
  // host) having git identity configured globally — a fresh clone of
  // EVIDENCE_CHECKOUT_DIR has neither, and `git commit` refuses to guess.
  // Same "${slug}[bot]" convention used for the GitHub App's PR/issue
  // authorship elsewhere (see config.ts's githubAppSlug).
  await execFileAsync('git', [
    '-c', `user.name=${config.githubAppSlug}[bot]`,
    '-c', `user.email=${config.githubAppId}+${config.githubAppSlug}[bot]@users.noreply.github.com`,
    'commit',
    '-m', `evidence: e2e screenshots for ${config.productRepo} PR #${prNumber}`,
  ], { cwd: EVIDENCE_CHECKOUT_DIR });
  await execFileAsync('git', ['push', 'origin', 'main'], { cwd: EVIDENCE_CHECKOUT_DIR });

  log.info(`published ${committed.length} evidence screenshot(s) for PR #${prNumber} to ${config.valeriaRepo}`);
  return committed;
}

export function rawEvidenceUrl(path: string): string {
  return `https://raw.githubusercontent.com/${config.valeriaRepo}/main/${path}`;
}
