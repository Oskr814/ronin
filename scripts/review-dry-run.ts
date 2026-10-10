// Runs the external review on one PR at one exact commit and writes what it
// would publish to a Markdown file — nothing is posted to GitHub. Used to
// validate prompt/criteria changes against PRs that were already reviewed
// (see docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md,
// "Validación antes de activar").
//
//   pnpm review:dry-run --repo redmotos/shoppingcart --pr 746 --sha 62b66af [--out logs/dry-run/746-62b66af.md]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { loadRepos } from '../src/repos.js';
import { withActiveRepo } from '../src/repo-context.js';
import { runExternalReview } from '../src/review-publish.js';

const execFileAsync = promisify(execFile);

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    pr: { type: 'string' },
    sha: { type: 'string' },
    out: { type: 'string' },
  },
});

if (!values.repo || !values.pr || !values.sha) {
  console.error('Uso: pnpm review:dry-run --repo <owner/name> --pr <número> --sha <commit> [--out <archivo.md>]');
  process.exit(1);
}

const prNumber = Number(values.pr);
const repos = await loadRepos();
const repo = repos.find((r) => r.productRepo === values.repo);
if (!repo) {
  console.error(`${values.repo} no está en repos.json`);
  process.exit(1);
}

await withActiveRepo(repo, async () => {
  const git = async (args: string[]) => (await execFileAsync('git', args, { cwd: repo.productRepoPath })).stdout.trim();
  const ghEnv = { ...process.env, GH_TOKEN: config.githubToken };

  // A SHA from an earlier round may have been force-pushed away; it is
  // usually still in the local object store (it was for every SHA analyzed
  // in the spec). If not, the PR head ref is the only place left to try.
  let headSha: string;
  try {
    headSha = await git(['rev-parse', '--verify', `${values.sha}^{commit}`]);
  } catch {
    await git(['fetch', 'origin', `pull/${prNumber}/head`]);
    headSha = await git(['rev-parse', '--verify', `${values.sha}^{commit}`]);
  }

  const { stdout } = await execFileAsync('gh', ['pr', 'view', String(prNumber), '--repo', repo.productRepo, '--json', 'baseRefName,headRefName'], { env: ghEnv });
  const { baseRefName, headRefName } = JSON.parse(stdout) as { baseRefName: string; headRefName: string };

  const outFile = values.out ?? `logs/dry-run/${prNumber}-${headSha.slice(0, 7)}.md`;
  console.log(`Revisando PR #${prNumber} @ ${headSha.slice(0, 7)} (base ${baseRefName}) — salida en ${outFile}`);
  await runExternalReview(
    { prNumber, headRefName, headSha, baseRefName, openThreads: [], mentions: [] },
    { dryRun: { outFile } },
  );
  console.log(`Listo: ${outFile}`);
});
