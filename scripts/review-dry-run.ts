// Runs the external review on one PR at one exact commit and writes what it
// would publish to a Markdown file — nothing is posted to GitHub. Used to
// validate prompt/criteria changes against PRs that were already reviewed
// (see docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md,
// "Validación antes de activar").
//
//   pnpm review:dry-run --repo redmotos/shoppingcart --pr 746 --sha 62b66af [--prev <sha>] [--threads] [--out logs/dry-run/746-62b66af.md]
//
// --prev runs it in incremental mode against that earlier reviewed SHA.
// Without --threads the review sees no thread history: on a past round, the
// PR's current threads include findings from later rounds that would leak
// into the run. Pass it only when --sha is the PR's current head.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { config } from '../src/core/config.js';
import { loadRepos } from '../src/core/repos.js';
import { withActiveRepo } from '../src/core/repo-context.js';
import { runExternalReview } from '../src/review/index.js';
import { listBotReviewThreads } from '../src/core/github.js';

const execFileAsync = promisify(execFile);

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    pr: { type: 'string' },
    sha: { type: 'string' },
    prev: { type: 'string' },
    threads: { type: 'boolean' },
    out: { type: 'string' },
  },
});

if (!values.repo || !values.pr || !values.sha) {
  console.error('Uso: pnpm review:dry-run --repo <owner/name> --pr <número> --sha <commit> [--prev <commit>] [--threads] [--out <archivo.md>]');
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
  const resolve = async (sha: string) => {
    try {
      return await git(['rev-parse', '--verify', `${sha}^{commit}`]);
    } catch {
      await git(['fetch', 'origin', `pull/${prNumber}/head`]);
      return git(['rev-parse', '--verify', `${sha}^{commit}`]);
    }
  };
  const headSha = await resolve(values.sha!);
  const previousSha = values.prev ? await resolve(values.prev) : undefined;

  const { stdout } = await execFileAsync('gh', ['pr', 'view', String(prNumber), '--repo', repo.productRepo, '--json', 'baseRefName,headRefName,isCrossRepository'], { env: ghEnv });
  const { baseRefName, headRefName, isCrossRepository } = JSON.parse(stdout) as { baseRefName: string; headRefName: string; isCrossRepository: boolean };

  const outFile = values.out ?? `logs/dry-run/${prNumber}-${headSha.slice(0, 7)}.md`;
  const threadHistory = values.threads ? await listBotReviewThreads(prNumber, config.githubLogin) : [];
  const openThreads = threadHistory.filter((t) => !t.isResolved).map((t) => ({ id: t.id, body: t.body, url: t.url }));
  const mode = previousSha ? `incremental desde ${previousSha.slice(0, 7)}` : 'completo';
  console.log(`Revisando PR #${prNumber} @ ${headSha.slice(0, 7)} (base ${baseRefName}, ${mode}, ${threadHistory.length} threads, ${isCrossRepository ? 'fork: sin ejecutar' : 'con verificación por tests'}) — salida en ${outFile}`);
  await runExternalReview(
    { prNumber, headRefName, headSha, baseRefName, ...(previousSha ? { previousSha } : {}), threadHistory, openThreads, mentions: [], canExecute: !isCrossRepository },
    { dryRun: { outFile } },
  );
  console.log(`Listo: ${outFile}`);
});
