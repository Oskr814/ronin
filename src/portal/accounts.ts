import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../core/config.js';
import { acquireLock } from '../core/worker-launch.js';

// The request portal's accounts (#114): people without GitHub, who enter
// with their email and a password. Kept in <PORTAL_DATA_DIR>/accounts.json,
// the only copy there is — unlike .ronin-state.json, which is a cache, so a
// file that doesn't read is an error here, never an empty list.
//
// Nobody signs up: an admin creates the account from the dashboard and the
// person sets their password from a link sent by email (an invitation, or a
// reset when they forgot it). The link's token is stored only as its hash.

export interface PortalGrant {
  // productRepo, and an app of its `portal.apps` in repos.json.
  repo: string;
  app: string;
}

export interface PortalUser {
  id: string;
  email: string;
  name: string;
  // Absent until the person sets it from their invitation.
  passwordHash?: string;
  grants: PortalGrant[];
  // Requests per day; absent, PORTAL_DAILY_LIMIT.
  dailyLimit?: number;
  disabled: boolean;
  // Every session cookie carries it; changing the password or disabling the
  // account bumps it, so every session open until then stops working.
  sessionVersion: number;
  link?: { tokenHash: string; kind: LinkKind; expiresAt: string };
  createdAt: string;
  // The dashboard login of the admin who created it.
  createdBy: string;
  lastLoginAt?: string;
}

export type LinkKind = 'invite' | 'reset';

interface AccountsFile {
  users: PortalUser[];
}

export class AccountError extends Error {}

export const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 120;
const EMAIL_MAX = 254;
const DAILY_LIMIT_MAX = 100;
const LOCK_POLL_MS = 50;

const accountsPath = () => join(config.portal.dataDir, 'accounts.json');

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const isEmail = (email: string) => email.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');

async function readAccounts(): Promise<AccountsFile> {
  let raw: string;
  try {
    raw = await readFile(accountsPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { users: [] };
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<AccountsFile>;
  if (!Array.isArray(parsed.users)) throw new Error(`${accountsPath()} no tiene la lista de usuarios`);
  return { users: parsed.users };
}

// Written aside and renamed into place, readable only by this user: it holds
// the password hashes.
async function writeAccounts(data: AccountsFile): Promise<void> {
  await mkdir(config.portal.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${accountsPath()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, accountsPath());
}

// Read, change and write under a lock: the server is one process, but the
// tick will read the accounts too once it sends the requests' emails.
let queue: Promise<unknown> = Promise.resolve();
function withAccounts<T>(fn: (data: AccountsFile) => T | Promise<T>): Promise<T> {
  const locked = async () => {
    const lock = `${accountsPath()}.lock`;
    while (!(await acquireLock(lock))) await sleep(LOCK_POLL_MS);
    try {
      const data = await readAccounts();
      const before = JSON.stringify(data);
      const result = await fn(data);
      if (JSON.stringify(data) !== before) await writeAccounts(data);
      return result;
    } finally {
      await rm(lock, { force: true });
    }
  };
  const result = queue.then(locked, locked);
  queue = result.then(() => {}, () => {});
  return result;
}

export async function listUsers(): Promise<PortalUser[]> {
  return (await readAccounts()).users;
}

export async function getUser(id: string): Promise<PortalUser | undefined> {
  return (await readAccounts()).users.find((u) => u.id === id);
}

export async function findUserByEmail(email: string): Promise<PortalUser | undefined> {
  const wanted = normalizeEmail(email);
  return (await readAccounts()).users.find((u) => u.email === wanted);
}

export interface UserFields {
  name: string;
  grants: PortalGrant[];
  dailyLimit?: number | null;
}

function checkFields(fields: Partial<UserFields>): void {
  if (fields.name !== undefined && (!fields.name.trim() || fields.name.length > NAME_MAX)) throw new AccountError(`El nombre es obligatorio (hasta ${NAME_MAX} caracteres).`);
  if (fields.dailyLimit !== undefined && fields.dailyLimit !== null && (!Number.isInteger(fields.dailyLimit) || fields.dailyLimit < 0 || fields.dailyLimit > DAILY_LIMIT_MAX)) {
    throw new AccountError(`El tope diario debe ser un entero entre 0 y ${DAILY_LIMIT_MAX}.`);
  }
}

const dedupeGrants = (grants: PortalGrant[]) => grants.filter((g, i) => grants.findIndex((o) => o.repo === g.repo && o.app === g.app) === i);

export async function createUser(fields: UserFields & { email: string; createdBy: string }, now = new Date()): Promise<PortalUser> {
  const email = normalizeEmail(fields.email);
  if (!isEmail(email)) throw new AccountError('Ese correo no es válido.');
  checkFields(fields);
  return withAccounts((data) => {
    if (data.users.some((u) => u.email === email)) throw new AccountError(`Ya hay una cuenta con ${email}.`);
    const user: PortalUser = {
      id: randomBytes(9).toString('base64url'),
      email,
      name: fields.name.trim(),
      grants: dedupeGrants(fields.grants),
      ...(typeof fields.dailyLimit === 'number' ? { dailyLimit: fields.dailyLimit } : {}),
      disabled: false,
      sessionVersion: 1,
      createdAt: now.toISOString(),
      createdBy: fields.createdBy,
    };
    data.users.push(user);
    return user;
  });
}

// What an admin can change. Disabling also drops the pending link and ends
// every session.
export async function updateUser(id: string, patch: Partial<UserFields> & { disabled?: boolean }): Promise<PortalUser> {
  checkFields(patch);
  return withAccounts((data) => {
    const user = data.users.find((u) => u.id === id);
    if (!user) throw new AccountError('No existe esa cuenta.');
    if (patch.name !== undefined) user.name = patch.name.trim();
    if (patch.grants !== undefined) user.grants = dedupeGrants(patch.grants);
    if (patch.dailyLimit === null) delete user.dailyLimit;
    else if (patch.dailyLimit !== undefined) user.dailyLimit = patch.dailyLimit;
    if (patch.disabled !== undefined && patch.disabled !== user.disabled) {
      user.disabled = patch.disabled;
      if (patch.disabled) {
        delete user.link;
        user.sessionVersion += 1;
      }
    }
    return user;
  });
}

// A new link for the person to set their password: it replaces any earlier
// one. Returns the token, which only travels in the email.
export async function issueLink(id: string, kind: LinkKind, now = Date.now()): Promise<{ user: PortalUser; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const user = await withAccounts((data) => {
    const found = data.users.find((u) => u.id === id);
    if (!found) throw new AccountError('No existe esa cuenta.');
    if (found.disabled) throw new AccountError('La cuenta está desactivada.');
    found.link = { tokenHash: hashToken(token), kind, expiresAt: new Date(now + LINK_TTL_MS).toISOString() };
    return found;
  });
  return { user, token };
}

// The account a link is for, while it's still good: for the page to say
// whose password it sets, before it's set.
export async function userForLink(token: string, now = Date.now()): Promise<PortalUser | undefined> {
  const hash = hashToken(token);
  return (await readAccounts()).users.find((u) => !u.disabled && u.link?.tokenHash === hash && Date.parse(u.link.expiresAt) > now);
}

// Sets the password with a link, which is then used up. Every session open
// until now ends: whoever had the old password is out.
export async function redeemLink(token: string, passwordHash: string, now = Date.now()): Promise<PortalUser | undefined> {
  const hash = hashToken(token);
  return withAccounts((data) => {
    const user = data.users.find((u) => !u.disabled && u.link?.tokenHash === hash && Date.parse(u.link.expiresAt) > now);
    if (!user) return undefined;
    user.passwordHash = passwordHash;
    delete user.link;
    user.sessionVersion += 1;
    return user;
  });
}

export async function recordLogin(id: string, now = new Date()): Promise<void> {
  await withAccounts((data) => {
    const user = data.users.find((u) => u.id === id);
    if (user) user.lastLoginAt = now.toISOString();
  });
}

// What the dashboard shows of an account: never the hash or the token.
export function adminView(user: PortalUser) {
  const { passwordHash, link, ...rest } = user;
  return {
    ...rest,
    hasPassword: Boolean(passwordHash),
    ...(link ? { link: { kind: link.kind, expiresAt: link.expiresAt } } : {}),
  };
}
