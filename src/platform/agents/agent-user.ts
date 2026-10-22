import { basename, dirname } from 'node:path';
import { config } from '../config/config.js';
import { host, type ExecOptions } from '../host/host.js';
import { activeRepo, type RepoEntry } from './repo-context.js';
import { loadRepos } from '../config/repos.js';

// The user an agent with actions runs as (#257): not root, so it can't read
// ronin's environment (/proc of its processes), its data (/data), the Docker
// certificates or the Tailscale socket — what it changes outside its
// checkout goes through ronin's actions.
//
// One per Claude account (repos.json's claudeConfigDir), which is one per
// repo today: an agent of one repo can't read another's clones, account or
// environment. Not one per run: the runs of an account share its files,
// which Claude writes as 600 and renews in place, so they have to be the
// same user's. What a run of the same repo could take from another (its
// actions credential) is no use to it: the actions server answers only its
// own run's processes (actions/peer.ts).
//
// The image says where the users go (RONIN_AGENT_UID_BASE); they are made
// as needed, with a uid that comes from the account's name, so it's the same
// one every time. Without it (a runner installed by hand) agents run as
// ronin's own user, as before.

export interface AgentUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

const UID_SPAN = 5_000;

// FNV-1a: the same account, the same uid, in every container.
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

export function agentUserFor(claudeConfigDir: string): AgentUser | null {
  if (config.agentUidBase == null || !Number.isFinite(config.agentUidBase)) return null;
  const account = (basename(claudeConfigDir) || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'default';
  const name = `agent-${account}`;
  const uid = config.agentUidBase + 1 + (hash(name) % UID_SPAN);
  return { name, uid, gid: uid, home: `${config.agentHomeBase}/${name}` };
}

// The active repo's agent: its Claude account's.
export function repoAgentUser(): AgentUser | null {
  return agentUserFor(activeRepo().claudeConfigDir ?? config.claudeConfigDir ?? '');
}

// How to run a command as that user: its ids and an environment of its own,
// nothing of ronin's.
export function asAgent(user: AgentUser, opts: ExecOptions = {}): ExecOptions {
  return {
    ...opts,
    uid: user.uid,
    gid: user.gid,
    env: { PATH: process.env.PATH, HOME: user.home, LANG: process.env.LANG ?? 'C.UTF-8', ...opts.env },
  };
}

const made = new Map<string, Promise<void>>();

// The user, made if it isn't there yet. It reads the shared clones, which
// are root's: git refuses another user's repo unless told it's safe — the
// other way around never happens, ronin never runs git as root inside the
// agent's own clone.
function makeUser(user: AgentUser): Promise<void> {
  let making = made.get(user.name);
  if (!making) {
    making = (async () => {
      const existing = (await host().exec('getent', ['passwd', String(user.uid)]).catch(() => ({ stdout: '' }))).stdout.split(':')[0];
      if (existing && existing !== user.name) throw new Error(`el uid ${user.uid} de ${user.name} ya es de ${existing}`);
      if (!existing) {
        await host().exec('useradd', ['--uid', String(user.uid), '--user-group', '--create-home', '--home-dir', user.home, '--shell', '/bin/bash', user.name]);
        await host().exec('git', ['config', '--global', 'safe.directory', '*'], asAgent(user));
      }
    })();
    made.set(user.name, making);
    making.catch(() => made.delete(user.name));
  }
  return making;
}

// A repo's own directory — its clone and its worktrees, when they share one
// (the image's layout, /repos/<org>/<repo>/{repo,ronin-worktrees}) — open
// only to root and its account's agent.
async function fence(entry: RepoEntry): Promise<void> {
  const user = agentUserFor(entry.claudeConfigDir ?? config.claudeConfigDir ?? '');
  const root = dirname(entry.productRepoPath);
  const worktrees = process.env.WORKTREE_BASE_PATH || `${root}/ronin-worktrees`;
  if (!user || !worktrees.startsWith(`${root}/`)) return;
  await makeUser(user);
  await host().exec('chgrp', [String(user.gid), root]);
  await host().exec('chmod', ['750', root]);
}

let fenced: Promise<void> | null = null;

// Before the first run as an agent: its user, and every repo of repos.json
// closed to the other accounts' agents — not only this one's, or a repo
// that hasn't run yet would stay open to them.
export async function prepareAgentUser(user: AgentUser): Promise<void> {
  await makeUser(user);
  fenced ??= loadRepos().then((repos) => Promise.all(repos.map(fence))).then(() => {});
  try {
    await fenced;
  } catch (error) {
    fenced = null;
    throw error;
  }
}

// The run's Claude account goes to the agent's user: `claude` reads its
// credentials and writes its sessions there, and renews the token in
// place. ronin, as root, keeps reading and writing it as before.
export async function lendClaudeAccount(dir: string, user: AgentUser): Promise<void> {
  await host().exec('chown', ['-R', `${user.uid}:${user.gid}`, dir]);
}
