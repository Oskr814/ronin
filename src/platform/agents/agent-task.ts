import { join, resolve } from 'node:path';
import { ensureWorktree, ensureExternalReviewWorktree, removeExternalReviewWorktree, ensureTrustedFixWorktree, removeTrustedFixWorktree, ensureAgentClone, removeAgentClone, ensureAgentPrClone, removeAgentPrClone, ensureAgentBranchClone } from '../git/worktree.js';
import { runClaudeHeadless, ClaudeTimeoutError, ClaudeUsageLimitError } from '../claude/claude-runner.js';
import { accountName } from '../claude/claude-usage.js';
import { RunRecord, type RunOutcome } from './run-record.js';
import { config, agentModelFor, agentEffortFor } from '../config/config.js';
import { activeRepo, withActiveRepo } from './repo-context.js';
import { log } from '../logger.js';
import { recordAgentRun } from './metrics.js';
import { currentRunGroup } from './run-group.js';
import { host } from '../host/host.js';
import type { RunScope } from '../actions/catalog.js';
import { agentCheckout, checkoutState, executeAction, rootCheckout, type RunApp, type RunCheckout, type RunServices, type RunTools } from '../actions/executors.js';
import { asAgent, prepareAgentUser, repoAgentUser, type AgentUser } from './agent-user.js';
import { startActionsServer, type ActionsServer } from '../actions/server.js';
import { mintReadToken } from '../github/read-token.js';

// ronin's skills (`claude --plugin-dir`) and the agent's client for its
// actions, next to ronin's own code: in the image, /app/plugin and /app/bin.
const PLUGIN_DIR = resolve('plugin');
const ACTIONS_BIN_DIR = resolve('bin');

// The mechanics every agent run shares: the checkout it runs in, `claude -p`
// with its type's model and effort, the run record, metrics and cleanup.
// What the agent is told is each feature's business: its prompts.ts turns
// its own task types into an AgentTask (see platform/agents/prompts.ts for the rules
// they share), and nothing here knows about any of them.

// Where a run happens.
export type TaskCheckout =
  // A ronin worktree on the task's branch, created from baseBranch when the
  // branch doesn't exist yet (worktree.ts's ensureWorktree).
  | { kind: 'branch'; baseBranch?: string }
  // A checkout the caller already set up and owns, or a function that
  // brings one up to date and returns it.
  | { kind: 'dir'; dir: string | (() => Promise<string>) }
  // The head of a PR someone else opened, by SHA, never by branch name: a
  // fork's head branch may not exist in this repo at all (or may collide
  // with a local ref, including the primary worktree's own `main`), and a
  // re-review must always see the PR's current head — see final review
  // Fix 1. Its code is untrusted, so the run strips the project config
  // Claude Code would load from it, and the checkout goes once it ends.
  | { kind: 'untrusted-pr-head'; prNumber: number; sha: string }
  // The branch of an open, same-repo PR, detached: a person's branch is
  // routinely checked out in the primary worktree at the same time (the
  // human who asked is often the one actively developing it there), and a
  // plain branch checkout would collide with that, same class of failure as
  // the fork case above — see ensureTrustedFixWorktree. ronin's own PRs use
  // it too when they work through actions (#257): the run only amends and
  // pushes what the PR already has. Removed once it ends.
  | { kind: 'pr-branch' };

// A subagent the run can launch, in `claude --agents` format.
export interface AgentDefinition {
  description: string;
  prompt: string;
  tools: string[];
  model?: string;
}

// How a run may push (RunScope's push), as the task says it: the base of
// its own branch by name, resolved when the run starts.
export type PushRule = { mode: 'amend' } | { mode: 'fast-forward' } | { mode: 'branch'; baseRef: string };

export interface PreparedTask {
  // The branch the task works on; for a checkout that isn't a ronin
  // worktree of its own, only a label for the log.
  branch: string;
  prompt: string;
  checkout: TaskCheckout;
  // How the log, the run record and the runner name the run when it isn't
  // the task's issue or PR: "pedido P-3", "app backoffice".
  label?: string;
  tag?: string | number;
  // Written to `path` for `claude --agents`, and removed after the run.
  agents?: { path: string; definitions: Record<string, AgentDefinition> };
  mcpConfigFile?: string;
  // A run that works through ronin's actions and skills (#257): what it may
  // do — the commit it starts from is the checkout's HEAD, taken once the
  // checkout exists. It runs sealed (claude-runner.ts's sealedEnv) and
  // reaches the actions with `ronin-act`.
  actions?: Omit<RunScope, 'startSha' | 'push'> & { push?: PushRule };
  // What the services.* actions run (domains/product-app/services.ts):
  // made once the checkout exists, closed when the run ends.
  services?: (checkoutDir: string, owner: AgentUser | null) => RunServices;
  // The app the run works on, which the task already brought up: what
  // app.exec runs in.
  app?: RunApp;
  // A run that only reads and leaves its result in files (#257): sealed,
  // as the agent's user, with the read token, writing only in outputDir —
  // which it gets for the run, with whatever ronin put there for it to
  // read, and which ronin takes back before the task reads it (reclaimOutput).
  sealed?: { outputDir: string };
}

export interface AgentTask {
  // Picks the model and effort (config.ts's agentModelFor) and names the run
  // in the metrics and the dashboard.
  type: string;
  issueNumber?: number;
  prNumber?: number;
  requestNumber?: number;
  meetingNumber?: number;
  sliceIndex?: number;
  sliceTitle?: string;
  // Builds the prompt and says where it runs; called once, first thing.
  prepare(): Promise<PreparedTask>;
}

function runOutcome(error: unknown): RunOutcome {
  if (error instanceof ClaudeUsageLimitError) return 'usage_limit';
  if (error instanceof ClaudeTimeoutError) return 'timeout';
  return 'error';
}

// `as`: the run goes as the agent's user (agent-user.ts), which on a PR's
// branch or head gets a clone of its own (worktree.ts's ensureAgentClone).
// A `dir` checkout stays root's: a sealed run only reads it.
async function checkoutDir(checkout: TaskCheckout, branch: string, as: AgentUser | null): Promise<string> {
  switch (checkout.kind) {
    case 'branch': return as ? ensureAgentBranchClone(branch, checkout.baseBranch ?? activeRepo().worktreeBaseRef ?? config.worktreeBaseRef, as) : ensureWorktree(branch, checkout.baseBranch);
    case 'dir': return typeof checkout.dir === 'string' ? checkout.dir : checkout.dir();
    case 'untrusted-pr-head': return as ? ensureAgentPrClone(checkout.prNumber, checkout.sha, as) : ensureExternalReviewWorktree(checkout.prNumber, checkout.sha);
    case 'pr-branch': return as ? ensureAgentClone(branch, as) : ensureTrustedFixWorktree(branch);
  }
}

// Which runs go as the agent's user (#257): one with actions on a branch
// (a PR's, or its own), and one sealed that only reads. The rest still run
// as ronin.
async function runsAs(checkout: TaskCheckout, actions: PreparedTask['actions'], sealed: PreparedTask['sealed']): Promise<AgentUser | null> {
  const user = (actions && (checkout.kind === 'pr-branch' || checkout.kind === 'branch')) || sealed ? repoAgentUser() : null;
  if (user) await prepareAgentUser(user);
  return user;
}

// The run's output directory goes to the agent's user, with what ronin left
// there for it to read.
async function handOutput(dir: string, user: AgentUser): Promise<void> {
  await host().fs.mkdir(dir, { recursive: true });
  await host().exec('chown', ['-R', `${user.uid}:${user.gid}`, dir]);
  await host().exec('chmod', ['700', dir]);
}

// And back to root before the task reads it: the directory, moved aside in
// one step so nothing of the agent's can still change it, and only its
// regular files brought back — never a link, which could point root at a
// file the agent can't read (a review publishes what it finds there).
export async function reclaimOutput(dir: string): Promise<void> {
  const aside = `${dir}.agent-${Date.now()}`;
  await host().fs.rename(dir, aside);
  await host().fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const walk = async (from: string, to: string): Promise<void> => {
    for (const entry of await host().fs.readdir(from, { withFileTypes: true })) {
      if (entry.isFile()) {
        await host().fs.rename(join(from, entry.name), join(to, entry.name));
      } else if (entry.isDirectory()) {
        await host().fs.mkdir(join(to, entry.name), { recursive: true, mode: 0o700 });
        await walk(join(from, entry.name), join(to, entry.name));
      }
    }
  };
  try {
    await walk(aside, dir);
  } finally {
    await host().fs.rm(aside, { recursive: true, force: true });
  }
}

export async function runAgentTask(task: AgentTask): Promise<string> {
  const { branch, prompt, checkout, agents, mcpConfigFile, actions, services: makeServices, app, sealed, ...prepared } = await task.prepare();
  const as = await runsAs(checkout, actions, sealed);
  const worktreeDir = await checkoutDir(checkout, branch, as);

  // An untrusted PR head is the only checkout that points `claude -p
  // --permission-mode bypassPermissions` at a tree an arbitrary external
  // contributor controls. Claude Code auto-loads project config from its cwd
  // (CLAUDE.md, .claude/settings.json hooks, skills), so a malicious PR could
  // otherwise get code execution on this host before the model reads a single
  // line of the diff. Removing both surfaces is blunt but effective.
  // Known follow-up, deliberately NOT attempted here: running this task type
  // under a restricted permission mode / explicit tool allowlist instead of
  // bypassPermissions, which needs a new parameter plumbed through
  // runClaudeHeadless (shared by every other task type).
  if (checkout.kind === 'untrusted-pr-head') {
    // In the agent's own clone, as its user: root never touches what the
    // PR's author controls.
    if (as) await host().exec('rm', ['-rf', '.claude', 'CLAUDE.md'], asAgent(as, { cwd: worktreeDir }));
    else {
      await host().fs.rm(join(worktreeDir, '.claude'), { recursive: true, force: true });
      await host().fs.rm(join(worktreeDir, 'CLAUDE.md'), { recursive: true, force: true });
    }
  }

  // A file rather than inline JSON: with every worker's criteria it's tens of
  // KB, too much for one argv entry to be comfortable.
  const agentsFile = agents?.path;
  if (agents) await host().fs.writeFile(agents.path, JSON.stringify(agents.definitions));

  const issueNumber = task.issueNumber;
  const prNumber = task.prNumber;
  const label = prepared.label ?? (issueNumber !== undefined ? `issue #${issueNumber}` : `PR #${prNumber}`);
  const tag = prepared.tag ?? issueNumber ?? prNumber;
  log.info(`starting ${task.type} for ${label} on branch ${branch}`);
  const start = Date.now();
  const model = agentModelFor(task.type);
  const effort = agentEffortFor(task.type);
  const group = currentRunGroup();
  // The run's own record, for the dashboard (run-record.ts).
  const record = RunRecord.start({
    repo: activeRepo().productRepo,
    taskType: task.type,
    label,
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(task.requestNumber !== undefined ? { portalRequest: task.requestNumber } : {}),
    ...(task.meetingNumber !== undefined ? { meeting: task.meetingNumber } : {}),
    ...(task.sliceIndex !== undefined ? { sliceIndex: task.sliceIndex, sliceTitle: task.sliceTitle } : {}),
    ...(group ? { group } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    account: accountName(activeRepo().claudeConfigDir ?? config.claudeConfigDir ?? ''),
    worktree: worktreeDir,
  });
  let server: ActionsServer | null = null;
  let services: RunServices | null = null;
  try {
    // Read-only and for this repo, when ronin has its App (read-token.ts);
    // without it the agent reads with the write token, as before.
    const readToken = actions || sealed ? await mintReadToken(activeRepo().productRepo) : null;
    if (sealed && as) await handOutput(sealed.outputDir, as);
    if (actions) {
      const runCheckout: RunCheckout = as
        ? agentCheckout(worktreeDir, activeRepo().productRepoPath, as)
        : rootCheckout(worktreeDir, activeRepo().productRepoPath);
      services = makeServices?.(worktreeDir, as) ?? null;
      server = await startRunActions(actions, runCheckout, { ...(services ? { services } : {}), ...(app ? { app } : {}) }, `${task.type} #${tag}`);
    }
    const result = await runClaudeHeadless(worktreeDir, prompt, `${task.type} #${tag}`, {
      model,
      effort,
      ...(agentsFile ? { agentsFile } : {}),
      ...(mcpConfigFile ? { mcpConfigFile } : {}),
      // ronin's skills, in every run: each task's behavior is its skill
      // (#257), sealed or not, with actions or without.
      pluginDir: PLUGIN_DIR,
      ...(server || sealed ? {
        ...(server ? { onSpawn: server.bind } : {}),
        sealedEnv: {
          ...(server ? { PATH: `${ACTIONS_BIN_DIR}:${process.env.PATH ?? ''}`, RONIN_ACTIONS_URL: server.url, RONIN_ACTIONS_TOKEN: server.token } : {}),
          ...(readToken ? { GH_TOKEN: readToken } : {}),
          ...(as ? { HOME: as.home } : {}),
        },
        ...(as ? { runAs: as } : {}),
      } : {}),
    }, record);
    if (sealed && as) await reclaimOutput(sealed.outputDir);
    // The status a run reports with result.report goes where the tasks that
    // ask for one already read it: the run's last line (RONIN_STATUS).
    const status = server?.report()?.status;
    if (server) logActions(server, `${task.type} for ${label}`, actions?.allowed ?? []);
    const durationMs = Date.now() - start;
    recordAgentRun(durationMs);
    log.metric('agent_run', { taskType: task.type, issueNumber, prNumber, durationMs, success: true });
    await record.end('ok');
    log.info(`finished ${task.type} for ${label}`);
    return status ? `${result}\nRONIN_STATUS: ${status}` : result;
  } catch (error) {
    const durationMs = Date.now() - start;
    recordAgentRun(durationMs);
    log.metric('agent_run', { taskType: task.type, issueNumber, prNumber, durationMs, success: false });
    await record.end(runOutcome(error), error);
    log.error(`${task.type} for ${label} failed`, error);
    throw error;
  } finally {
    // Success or failure, this checkout has no reason to survive the run —
    // nothing retries against it (the next tick re-fetches the PR's head
    // from scratch), so leaving it behind would just pile up one stale
    // detached worktree per external PR ever reviewed. Best-effort and
    // fully swallowed: a cleanup failure must never mask the real error nor
    // turn a successful review into a failed task.
    await server?.close();
    await services?.close().catch((cleanupError) => log.error(`${task.type}: no se pudieron bajar los servicios de ${label}`, cleanupError));
    if (agentsFile) await host().fs.rm(agentsFile, { force: true }).catch(() => {});
    if (checkout.kind === 'untrusted-pr-head') {
      await (as ? removeAgentPrClone(checkout.prNumber) : removeExternalReviewWorktree(checkout.prNumber)).catch((cleanupError) =>
        log.error(`${task.type} cleanup falló para PR #${checkout.prNumber}`, cleanupError),
      );
    }
    // Same reasoning as the untrusted head's cleanup above: nothing retries
    // against this checkout (the next tick re-fetches the branch's current
    // head from scratch), and — unlike ensureWorktree's own ronin/<issue>/…
    // branches — sweepOrphanedWorktrees never recognizes a human branch name
    // as its own, so a leftover here would never get swept.
    // The agent's clone of its own branch goes too: what it built is on
    // origin, and the next run clones it from there.
    if (checkout.kind === 'branch' && as) {
      await removeAgentClone(branch).catch((cleanupError) => log.error(`${task.type} cleanup falló para ${label}`, cleanupError));
    }
    if (checkout.kind === 'pr-branch') {
      await (as ? removeAgentClone(branch) : removeTrustedFixWorktree(branch)).catch((cleanupError) =>
        log.error(`${task.type} cleanup falló para PR #${prNumber}`, cleanupError),
      );
    }
  }
}

// The run's actions server, scoped to it: every action runs as ronin, in
// the run's repo, whatever async context the request arrives in.
async function startRunActions(scope: NonNullable<PreparedTask['actions']>, checkout: RunCheckout, tools: RunTools, label: string): Promise<ActionsServer> {
  const { push, ...rest } = scope;
  const runScope: RunScope = { ...rest, startSha: await checkout.git(['rev-parse', 'HEAD']) };
  if (push?.mode === 'branch') {
    // Its base as a commit, and what its branch had on origin, if anything:
    // a push may replace only that.
    const base = push.baseRef.startsWith('origin/') ? push.baseRef : `origin/${push.baseRef}`;
    const remoteSha = await host().exec('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${scope.headRef}`], { cwd: checkout.repo })
      .then(({ stdout }) => stdout.trim(), () => null);
    runScope.push = { mode: 'branch', baseSha: await checkout.git(['rev-parse', base]), remoteSha };
  } else if (push) runScope.push = push;
  const repo = activeRepo();
  return startActionsServer({
    scope: runScope,
    label,
    checkout: () => checkoutState(checkout, runScope),
    execute: (action) => withActiveRepo(repo, () => executeAction(runScope, checkout, action, tools)),
  });
}

// A run that ends without result.report did its work anyway — the actions
// it took are already on GitHub — so it isn't failed for it: it's left in
// the log, with what was refused.
function logActions(server: ActionsServer, label: string, allowed: readonly string[]): void {
  const refused = server.calls.filter((c) => c.outcome !== 'ok');
  const report = server.report();
  log.info(`${label}: ${server.calls.length} acción(es), ${refused.length} rechazada(s)${report ? ` — ${report.summary}` : ''}`);
  // Only a run that has result.report is expected to end with it.
  if (!report && allowed.includes('result.report')) log.error(`${label} terminó sin result.report`);
}
