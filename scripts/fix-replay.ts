// Replays a /fix-comments run on an external PR at one exact commit, with the
// current prompt and criteria, without touching GitHub or the PR branch. Used
// to validate the self-review step of the fix tasks against a fix that
// already went wrong (see docs/superpowers/plans/2026-10-10-exhaustive-external-review.md,
// Stage 3).
//
//   pnpm fix:replay --repo redmotos/shoppingcart --pr 753 --sha c8ad91b --trigger 4170981750 --thread 4169591567
//
// Sealed on purpose — the agent runs with bypassPermissions:
// - it works in a throwaway clone whose origin has no push URL;
// - gh has no credentials at all (no GH_TOKEN, empty GH_CONFIG_DIR);
// - the PR's review comments are downloaded up front, only those created
//   before the trigger, so nothing from later rounds leaks in.
// The result is the diff of the amended commit against --sha, plus the log.
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { config, agentModelFor, agentEffortFor } from '@platform/config/config.js';
import { loadRepos } from '@platform/config/repos.js';
import { withActiveRepo } from '@platform/agents/repo-context.js';
import { reviewTask } from '@domains/review/index.js';
import { claudeHeadlessArgs } from '@platform/claude/claude-runner.js';

const execFileAsync = promisify(execFile);

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    pr: { type: 'string' },
    sha: { type: 'string' },
    trigger: { type: 'string' },
    thread: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
});

if (!values.repo || !values.pr || !values.sha || !values.trigger || !values.thread?.length) {
  console.error('Uso: pnpm fix:replay --repo <owner/name> --pr <n> --sha <commit> --trigger <comment id> --thread <comment id> [--thread …] [--out <dir>]');
  process.exit(1);
}

const prNumber = Number(values.pr);
const repo = (await loadRepos()).find((r) => r.productRepo === values.repo);
if (!repo) {
  console.error(`${values.repo} no está en repos.json`);
  process.exit(1);
}

interface RawComment {
  id: number;
  body: string;
  created_at: string;
  path: string;
  line: number | null;
  original_line: number | null;
  in_reply_to_id?: number;
  user: { login: string } | null;
}

await withActiveRepo(repo, async () => {
  const ghEnv = { ...process.env, GH_TOKEN: config.githubToken };
  const ghApi = async (path: string) =>
    (await execFileAsync('gh', ['api', '--paginate', path, '--jq', '.[]'], { env: ghEnv, maxBuffer: 64 * 1024 * 1024 })).stdout;

  const all = (await ghApi(`repos/${repo.productRepo}/pulls/${prNumber}/comments?per_page=100`))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RawComment);
  const trigger = all.find((c) => c.id === Number(values.trigger));
  if (!trigger) throw new Error(`no encontré el comentario ${values.trigger} entre los comentarios inline del PR`);
  const before = all.filter((c) => c.created_at < trigger.created_at);
  const threads = values.thread!.map((id) => {
    const c = before.find((x) => x.id === Number(id));
    if (!c) throw new Error(`el hilo ${id} no existe antes del trigger`);
    return { id: `comment-${c.id}`, body: c.body };
  });

  const outDir = values.out ?? `logs/fix-replay/${prNumber}-${values.sha}`;
  await mkdir(outDir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'ronin-fix-replay-'));
  const clone = join(work, 'repo');
  const ghConfig = join(work, 'gh-config');
  const commentsFile = join(work, 'pr-review-comments.json');
  await mkdir(ghConfig);
  await writeFile(
    commentsFile,
    JSON.stringify(
      before.map((c) => ({ id: c.id, author: c.user?.login, created_at: c.created_at, path: c.path, line: c.line ?? c.original_line, in_reply_to_id: c.in_reply_to_id, body: c.body })),
      null,
      2,
    ),
  );

  const git = async (cwd: string, args: string[]) => (await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  await execFileAsync('git', ['clone', '-q', '--shared', '--no-checkout', repo.productRepoPath, clone]);
  await git(clone, ['remote', 'set-url', '--push', 'origin', 'DISABLED-in-fix-replay']);
  // A clone does not inherit the source's local config; the amend needs an
  // identity, and the commit never leaves this clone anyway.
  for (const key of ['user.name', 'user.email']) {
    const value = await git(repo.productRepoPath, ['config', key]).catch(() => 'ronin-replay');
    await git(clone, ['config', key, value]);
  }
  await git(clone, ['checkout', '-q', '--detach', values.sha!]);
  const startSha = await git(clone, ['rev-parse', 'HEAD']);

  const { prompt } = await reviewTask({
    type: 'fix-comments-external',
    prNumber,
    headRefName: 'replay',
    trigger: [{ id: trigger.id, kind: 'review', body: trigger.body, reactionsEyes: 0, authorLogin: trigger.user?.login ?? '' }],
    openThreads: threads,
  }).prepare();
  const replayPrompt = [
    prompt,
    '',
    `REPLAY — this run is a rehearsal on a throwaway clone and overrides the instructions above where they conflict. GitHub is not reachable: gh has no credentials and the push URL is disabled. Do everything up to and including the amend and the self-review step, then stop: do not push, do not reply, do not resolve anything. The thread ids above are placeholders. Wherever the instructions say to read this PR's review comments with gh, read ${commentsFile} instead (every inline review comment on the PR before the /fix-comments command). Finish by printing, for each thread, what you would have replied, and what the self-review reported and what you did about it.`,
  ].join('\n');
  await writeFile(join(outDir, 'prompt.md'), replayPrompt);

  console.log(`Replay PR #${prNumber} @ ${startSha.slice(0, 7)} — ${threads.length} hilo(s) — salida en ${outDir}`);
  const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: ghConfig };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.RONIN_GITHUB_TOKEN;
  const claudeConfigDir = repo.claudeConfigDir ?? config.claudeConfigDir;
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;

  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(config.claudeCommand, claudeHeadlessArgs(replayPrompt, { model: agentModelFor('fix-comments-external'), effort: agentEffortFor('fix-comments-external') }), {
      cwd: clone,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let final = '';
    let buffer = '';
    const log: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        log.push(line);
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') final = String(event.result ?? '');
        } catch {
          // stray output, kept in the log
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => log.push(chunk.toString()));
    child.on('close', async (code) => {
      await writeFile(join(outDir, 'stream.jsonl'), log.join('\n'));
      code === 0 ? resolve(final) : reject(new Error(`claude terminó con código ${code}`));
    });
  });

  const endSha = await git(clone, ['rev-parse', 'HEAD']);
  const diff = await git(clone, ['diff', startSha, endSha]);
  await writeFile(join(outDir, 'fix.diff'), `${diff}\n`);
  await writeFile(join(outDir, 'result.md'), `${result}\n`);
  console.log(`Listo: ${endSha === startSha ? 'sin commit nuevo' : `amend ${endSha.slice(0, 7)}`} — ${outDir}`);
  await rm(work, { recursive: true, force: true });
});
