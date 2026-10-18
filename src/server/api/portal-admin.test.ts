import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { config } from '../../core/config.js';
import { getUser } from '../../portal/accounts.js';
import { createRequest } from '../../portal/requests.js';
import { portalAdminView, runPortalAdmin, type PortalAdminContext } from './portal-admin.js';

vi.mock('../../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

const send = vi.fn(async () => {});
const ctx: PortalAdminContext = {
  url: 'https://ronin-agent.example.com',
  enabled: true,
  dailyLimit: 5,
  admin: 'oskr814',
  send,
  entries: [
    { productRepo: 'redmotos/shoppingcart', productRepoPath: '/x', portal: { name: 'Red Motos', apps: { backoffice: { name: 'Backoffice' } } } },
    { productRepo: 'Bmedical/bmedical', productRepoPath: '/y', portal: { name: 'Bmedical', apps: { webapp: { name: 'Webapp' } } } },
  ],
};
const grant = { repo: 'redmotos/shoppingcart', app: 'backoffice' };

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  send.mockReset();
  send.mockResolvedValue(undefined);
});

describe('portal admin', () => {
  it('creates an account and emails the invitation with the link and the apps it can ask in', async () => {
    const out = await runPortalAdmin(ctx, '/api/portal-admin/users', { email: 'MF@redmotoshn.com', name: 'María', grants: [grant], dailyLimit: 3 });
    expect(out).toMatchObject({ sent: true, user: { email: 'mf@redmotoshn.com', name: 'María', grants: [grant], dailyLimit: 3, hasPassword: false, link: { kind: 'invite' }, createdBy: 'oskr814' } });
    expect(out).not.toHaveProperty('url');
    const [mail, from] = send.mock.calls[0] as unknown as [{ to: string; subject: string; text: string; html: string }, string];
    expect(mail).toMatchObject({ to: 'mf@redmotoshn.com', subject: 'Te dieron acceso al portal de pedidos de ajustes' });
    expect(mail.text).toContain('Red Motos · Backoffice');
    expect(mail.text).toMatch(/https:\/\/ronin-agent\.example\.com\/contrasena#t=[\w-]{40,}/);
    expect(from).toBe('ronin · Pedidos de ajustes');
  });

  it('hands the link to the admin when the email fails', async () => {
    send.mockRejectedValue(new Error('SMTP caído'));
    const out = await runPortalAdmin(ctx, '/api/portal-admin/users', { email: 'mf@redmotoshn.com', name: 'María', grants: [] });
    expect(out).toMatchObject({ sent: false, url: expect.stringMatching(/\/contrasena#t=/) });
    expect((await portalAdminView(ctx)).users).toHaveLength(1);
  });

  it('only grants apps of the portal', async () => {
    await expect(runPortalAdmin(ctx, '/api/portal-admin/users', { email: 'mf@x.com', name: 'María', grants: [{ repo: 'redmotos/shoppingcart', app: 'tienda' }] })).rejects.toThrow(/no está en el portal/);
    await expect(runPortalAdmin(ctx, '/api/portal-admin/users', { email: 'mf@x.com', name: 'María', grants: 'todo' })).rejects.toThrow(/no está en el portal/);
  });

  it('edits and disables an account, and sends a new link: an invitation until it has a password', async () => {
    const { user } = await runPortalAdmin(ctx, '/api/portal-admin/users', { email: 'mf@x.com', name: 'María', grants: [] });
    const edited = await runPortalAdmin(ctx, `/api/portal-admin/users/${user.id}`, { name: 'María F.', grants: [grant, { repo: 'Bmedical/bmedical', app: 'webapp' }], dailyLimit: null });
    expect(edited.user).toMatchObject({ name: 'María F.', grants: [grant, { repo: 'Bmedical/bmedical', app: 'webapp' }] });

    send.mockClear();
    await runPortalAdmin(ctx, `/api/portal-admin/users/${user.id}/link`, {});
    expect((send.mock.calls[0] as unknown as [{ subject: string }])[0].subject).toMatch(/Te dieron acceso/);

    const off = await runPortalAdmin(ctx, `/api/portal-admin/users/${user.id}`, { disabled: true });
    expect(off.user).toMatchObject({ disabled: true });
    expect((await getUser(user.id))?.link).toBeUndefined();
    await expect(runPortalAdmin(ctx, `/api/portal-admin/users/${user.id}/link`, {})).rejects.toThrow(/desactivada/);
  });

  it('lists the apps that can be granted and the accounts, never a hash', async () => {
    await runPortalAdmin(ctx, '/api/portal-admin/users', { email: 'mf@x.com', name: 'María', grants: [grant] });
    const view = await portalAdminView(ctx);
    expect(view.apps.map((a) => `${a.org} · ${a.name}`)).toEqual(['Red Motos · Backoffice', 'Bmedical · Webapp']);
    expect(JSON.stringify(view)).not.toMatch(/tokenHash|passwordHash/);
  });

  it("shows each account's requests today against its daily limit", async () => {
    const { user: mf } = await runPortalAdmin(ctx, '/api/portal-admin/users', { email: 'mf@x.com', name: 'María', grants: [grant], dailyLimit: 2 });
    const { user: jp } = await runPortalAdmin(ctx, '/api/portal-admin/users', { email: 'jp@x.com', name: 'Juan', grants: [grant] });
    await createRequest({ userId: mf.id, repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'uno', images: [] });
    await createRequest({ userId: mf.id, repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'dos', images: [] });
    await createRequest({ userId: jp.id, repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'de ayer', images: [] }, new Date(Date.now() - 3 * 24 * 3600_000));
    const users = (await portalAdminView(ctx)).users;
    expect(users.map((u) => [u.name, u.today])).toEqual([['Juan', { used: 0, limit: 5 }], ['María', { used: 2, limit: 2 }]]);
  });

  it('records each change in the Registro of Ajustes (#174)', async () => {
    await rm(config.settings.dataDir, { recursive: true, force: true });
    const { user } = await runPortalAdmin(ctx, '/api/portal-admin/users', { email: 'persona@x.com', name: 'María', grants: [grant] });
    await runPortalAdmin(ctx, `/api/portal-admin/users/${user.id}`, { name: 'María José', dailyLimit: 9, disabled: true });
    const { readRegistro } = await import('./ajustes.js');
    expect((await readRegistro()).map((e) => `${e.what}: ${e.from} → ${e.to}`)).toEqual([
      'Usuarios · persona@x.com · cuenta: activa → desactivada',
      'Usuarios · persona@x.com · pedidos por día: el de General → 9',
      'Usuarios · persona@x.com · nombre: María → María José',
      'Usuarios · persona@x.com: — → invitado al portal',
    ]);
  });

  it('refuses to change anything while the portal is not configured', async () => {
    await expect(runPortalAdmin({ ...ctx, enabled: false }, '/api/portal-admin/users', { email: 'mf@x.com', name: 'María', grants: [] })).rejects.toThrow(/no está configurado/);
  });
});
