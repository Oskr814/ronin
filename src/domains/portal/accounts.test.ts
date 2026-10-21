import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../core/config.js';
import { getDb } from '../../db/db.js';
import { adminView, createUser, findUserByEmail, getUser, issueLink, LINK_TTL_MS, listUsers, redeemLink, updateUser, userForLink } from './accounts.js';

vi.mock('../../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

const file = () => join(config.portal.dataDir, 'accounts.json');
// store.pg.test.ts runs these again with the accounts in Postgres. What's
// kept, as text: the file, or the table's rows.
const onFiles = process.env.RONIN_TEST_STORE !== 'pg';
const stored = async () => {
  const db = getDb();
  return db ? JSON.stringify(await db.selectFrom('portal_users').selectAll().execute()) : readFile(file(), 'utf8');
};
const maria = { email: ' MFernandez@RedMotosHN.com ', name: 'María Fernández', grants: [{ repo: 'redmotos/shoppingcart', app: 'backoffice' }], createdBy: 'oskr814' };

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
});

describe('portal accounts', () => {
  it('creates an account by its normalized email, without a password, readable only by the runner', async () => {
    const user = await createUser(maria);
    expect(user).toMatchObject({ email: 'mfernandez@redmotoshn.com', name: 'María Fernández', disabled: false, sessionVersion: 1, createdBy: 'oskr814' });
    expect(user.passwordHash).toBeUndefined();
    expect((await findUserByEmail('MFERNANDEZ@redmotoshn.com'))?.id).toBe(user.id);
    if (onFiles) expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it('refuses a second account with the same email, and an invalid one', async () => {
    await createUser(maria);
    await expect(createUser({ ...maria, email: 'mfernandez@redmotoshn.com' })).rejects.toThrow(/Ya hay una cuenta/);
    await expect(createUser({ ...maria, email: 'no-es-correo' })).rejects.toThrow(/no es válido/);
    await expect(createUser({ ...maria, email: 'otra@x.com', name: '  ' })).rejects.toThrow(/nombre/);
    expect(await listUsers()).toHaveLength(1);
  });

  it('sets the password with a link once, and only while it lasts; the token is stored only as its hash', async () => {
    const user = await createUser(maria);
    const { token } = await issueLink(user.id, 'invite');
    expect(await stored()).not.toContain(token);
    expect((await userForLink(token))?.id).toBe(user.id);

    const done = await redeemLink(token, 'scrypt$hash');
    expect(done).toMatchObject({ passwordHash: 'scrypt$hash', sessionVersion: 2 });
    expect(done?.link).toBeUndefined();
    expect(await redeemLink(token, 'scrypt$otro')).toBeUndefined();

    const late = await issueLink(user.id, 'reset', Date.now() - LINK_TTL_MS - 1);
    expect(await userForLink(late.token)).toBeUndefined();
    expect(await redeemLink(late.token, 'scrypt$otro')).toBeUndefined();
  });

  it('a new link replaces the previous one', async () => {
    const user = await createUser(maria);
    const first = await issueLink(user.id, 'invite');
    const second = await issueLink(user.id, 'invite');
    expect(await userForLink(first.token)).toBeUndefined();
    expect((await userForLink(second.token))?.id).toBe(user.id);
  });

  it('disabling drops the pending link and ends every session', async () => {
    const user = await createUser(maria);
    const { token } = await issueLink(user.id, 'invite');
    const off = await updateUser(user.id, { disabled: true });
    expect(off).toMatchObject({ disabled: true, sessionVersion: 2 });
    expect(await userForLink(token)).toBeUndefined();
    await expect(issueLink(user.id, 'reset')).rejects.toThrow(/desactivada/);
    expect((await updateUser(user.id, { disabled: false })).sessionVersion).toBe(2);
  });

  it('edits the name, the grants and the daily limit; null puts the default back', async () => {
    const user = await createUser(maria);
    const grants = [{ repo: 'a/b', app: 'web' }, { repo: 'a/b', app: 'web' }];
    expect(await updateUser(user.id, { name: 'María F.', grants, dailyLimit: 3 })).toMatchObject({ name: 'María F.', grants: [{ repo: 'a/b', app: 'web' }], dailyLimit: 3 });
    expect((await updateUser(user.id, { dailyLimit: null })).dailyLimit).toBeUndefined();
    await expect(updateUser(user.id, { dailyLimit: 1.5 })).rejects.toThrow(/tope diario/);
    await expect(updateUser('nadie', { name: 'x' })).rejects.toThrow(/No existe/);
  });

  it("the dashboard's view never carries the hash or the token", async () => {
    const user = await createUser(maria);
    const { token } = await issueLink(user.id, 'invite');
    await redeemLink(token, 'scrypt$hash');
    await issueLink(user.id, 'reset');
    const view = adminView((await getUser(user.id))!);
    expect(view).toMatchObject({ hasPassword: true, link: { kind: 'reset' } });
    expect(JSON.stringify(view)).not.toMatch(/scrypt|tokenHash/);
  });

  it.skipIf(!onFiles)('a file that does not read is an error, never an empty list', async () => {
    await createUser(maria);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file(), '{ roto');
    await expect(listUsers()).rejects.toThrow();
  });
});
