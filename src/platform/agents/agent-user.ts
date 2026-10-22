import { config } from '../config/config.js';
import { host, type ExecOptions } from '../host/host.js';

// The user an agent with actions runs as (#257): not root, so it can't read
// ronin's environment (/proc of its processes), its data (/data), the Docker
// certificates or the Tailscale socket — what it changes outside its
// checkout goes through ronin's actions. It exists in the image
// (Dockerfile); without it (a runner installed by hand) agents run as
// ronin's own user, as before.
//
// Every agent runs as this same user, so one run could read another's
// environment while both are alive: their actions credentials and read
// tokens. Accepted for now — they are ronin's own runs; a user per run is
// the next step if it matters.

export interface AgentUser {
  uid: number;
  gid: number;
  home: string;
}

export function agentUser(): AgentUser | null {
  if (config.agentUid === null || config.agentGid === null || !config.agentHome) return null;
  return { uid: config.agentUid, gid: config.agentGid, home: config.agentHome };
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

// The run's Claude account goes to the agent's user: `claude` reads its
// credentials and writes its sessions there, and renews the token in
// place. ronin, as root, keeps reading and writing it as before.
export async function lendClaudeAccount(dir: string, user: AgentUser): Promise<void> {
  await host().exec('chown', ['-R', `${user.uid}:${user.gid}`, dir]);
}
