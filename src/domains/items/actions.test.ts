import { describe, it, expect, vi, beforeEach } from 'vitest';

const setIssueState = vi.fn();
vi.mock('../../core/github.js', () => ({ setIssueState: (...args: unknown[]) => setIssueState(...args) }));
vi.mock('../../core/config.js', () => ({ config: { githubLogin: 'ronin-agent' }, LABEL_AUTO_MERGE: 'ronin:auto-merge', LABEL_MANAGED: 'ronin' }));
vi.mock('../../core/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../core/repo-context.js', () => ({ withActiveRepo: (_entry: unknown, fn: () => unknown) => fn() }));

const { listActions, actionComment, runAction, ActionError } = await import('./actions.js');

const SESSION = { login: 'oskr814', token: 'gho_user' };
const post = vi.fn();
const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' };
const pr = (number: number) => ({ number, title: '', url: '', author: 'ronin-agent', isDraft: false, headRefName: 'ronin/844/slice-1', baseRefName: 'odoo-main', reviewDecision: '' as const, checks: [] });
const gh = (over: Record<string, unknown> = {}) => ({
  repo: 'acme/product', fetchedAt: '', blocks: {}, previews: [], openIssues: [], prIssue: {},
  issues: [{ number: 844, title: '', url: '', status: 'blocked' as const, direct: false, slices: [] }],
  prs: [pr(849)],
  ...over,
});
const discussion = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: '', body: '', author: '', createdAt: '', url: '', state: 'OPEN', labels: [], comments: [], ...extra });
const NEW_REF = { kind: 'issue' as const, number: 901 };
const unmanaged = (labels: string[] = []) => gh({ openIssues: [{ number: 901, title: '', url: '', labels }] });
const assign = vi.fn();
const close = vi.fn();
const APPS = ['webapp', 'backoffice'];
const PR_REF = { kind: 'pr' as const, number: 849, issue: 844 };
const ids = (actions: Array<{ id: string }>) => actions.map((a) => a.id);

beforeEach(() => {
  setIssueState.mockReset();
  assign.mockReset().mockResolvedValue({ url: 'https://github.com/acme/product/issues/901' });
  close.mockReset().mockResolvedValue({ url: 'https://github.com/acme/product/issues/844' });
  post.mockReset().mockResolvedValue({ id: 77, url: 'https://github.com/acme/product/pull/849#issuecomment-77' });
});

describe('listActions', () => {
  it("offers a PR's commands, resolving conflicts first when it has them", () => {
    const actions = listActions(PR_REF, gh(), { fetchedAt: '', pr: discussion(849, { mergeable: 'CONFLICTING' }) }, 'Oskr814');
    expect(ids(actions)).toEqual(['resolve-conflicts', 'preview', 'auto-merge-on']);
    expect(actions[0]).toMatchObject({ primary: true, target: 849 });
  });

  it('offers the apps for a preview when there are several, picking the one up or the only one the PR changes', () => {
    const PATHS = { webapp: 'apps/webapp', backoffice: 'apps/backoffice' };
    const changes = (files: string[]) => ({ fetchedAt: '', pr: discussion(849, { files }) });
    const of = (actions: Array<{ id: string }>) => actions.find((a) => a.id === 'preview');
    expect(of(listActions(PR_REF, gh(), changes(['apps/backoffice/src/a.tsx', 'packages/ui/b.tsx']), 'Oskr814', APPS, PATHS))).toMatchObject({ apps: APPS, app: 'backoffice', appNote: 'la que cambia el PR', preview: '@ronin-agent /preview {app}\n\n…' });
    expect(of(listActions(PR_REF, gh(), changes(['apps/backoffice/a.ts', 'apps/webapp/b.ts']), 'Oskr814', APPS, PATHS))).not.toHaveProperty('app');
    expect(of(listActions(PR_REF, gh({ previews: [{ prNumber: 849, appName: 'webapp', url: '' }] }), changes(['apps/backoffice/a.ts']), 'Oskr814', APPS, PATHS))).toMatchObject({ app: 'webapp', appNote: 'arriba ahora' });
    expect(of(listActions(PR_REF, gh(), changes(['apps/backoffice/a.ts']), 'Oskr814', ['backoffice'], PATHS))).not.toHaveProperty('apps');
  });

  it('offers to stop a preview that is up, and auto-merge off when its label is on', () => {
    const actions = listActions(PR_REF, gh({ previews: [{ prNumber: 849, appName: 'backoffice', url: '' }] }), { fetchedAt: '', pr: discussion(849, { labels: ['ronin:auto-merge'] }) }, 'Oskr814');
    expect(ids(actions)).toEqual(['resolve-conflicts', 'preview', 'preview-stop', 'auto-merge-off']);
    expect(actions[0].primary).toBe(false);
  });

  it("gives a blocked issue the way to unblock it, and its PR's commands aimed at the PR", () => {
    const actions = listActions({ kind: 'issue', number: 844, pr: 849 }, gh(), undefined, 'Oskr814');
    expect(ids(actions)).toEqual(['unblock', 'resolve-conflicts', 'preview', 'auto-merge-on', 'close-issue']);
    expect(actions[0]).toMatchObject({ target: 844, text: { required: true }, preview: '…' });
    expect(actions[1]).toMatchObject({ target: 849, label: 'Resolver conflictos en #849' });
    expect(actions[4]).toMatchObject({ target: 844, text: { required: false }, preview: '…' });
    expect(actions[4].help).toContain('#849 queda abierto');
  });

  it("offers an issue ronin doesn't manage to assign it, and a spike or a prototype on one of the repo's apps", () => {
    const actions = listActions(NEW_REF, unmanaged(), undefined, 'Oskr814', APPS);
    expect(ids(actions)).toEqual(['assign', 'spike', 'prototype', 'close-issue']);
    expect(actions[0]).toMatchObject({ primary: true, target: 901, text: { required: false }, preview: '…' });
    expect(actions[1]).toMatchObject({ apps: APPS, preview: '@ronin-agent /spike {app} …' });
  });

  it('offers only the assignment in a repo without apps, and only closing once ronin manages the issue', () => {
    expect(ids(listActions(NEW_REF, unmanaged(), undefined, 'Oskr814'))).toEqual(['assign', 'close-issue']);
    expect(ids(listActions(NEW_REF, unmanaged(['ronin']), undefined, 'Oskr814', APPS))).toEqual(['close-issue']);
    expect(ids(listActions({ kind: 'issue', number: 844 }, gh({ openIssues: [{ number: 844, title: '', url: '', labels: [] }] }), undefined, 'Oskr814', APPS))).toEqual(['unblock', 'close-issue']);
  });

  it('offers nothing for a PR that is no longer open', () => {
    expect(listActions(PR_REF, gh({ prs: [] }), undefined, 'Oskr814')).toEqual([]);
  });
});

describe('actionComment', () => {
  it('is the command after the mention, with what to prepare below it, or just the answer', () => {
    expect(actionComment({ id: 'resolve-conflicts', command: '/resolve-conflicts' })).toBe('@ronin-agent /resolve-conflicts');
    expect(actionComment({ id: 'preview', command: '/preview' }, 'un cliente con 12 pedidos')).toBe('@ronin-agent /preview\n\nun cliente con 12 pedidos');
    expect(actionComment({ id: 'unblock', command: '' }, 'vamos con (b)\nsin fecha')).toBe('vamos con (b)\nsin fecha');
  });
});

describe('runAction', () => {
  const detail = { fetchedAt: '', pr: discussion(849, { mergeable: 'CONFLICTING' }) };

  it('writes the command as the person, with their token; the webhook does the rest', async () => {
    const done = await runAction(ENTRY, PR_REF, gh(), detail, SESSION, 'resolve-conflicts', undefined, post);
    expect(post).toHaveBeenCalledWith('gho_user', 'acme/product', 849, '@ronin-agent /resolve-conflicts');
    expect(done.url).toContain('issuecomment-77');
    expect(setIssueState).not.toHaveBeenCalled();
  });

  it('puts what to prepare under /preview, and auto-merge through its own command', async () => {
    await runAction(ENTRY, PR_REF, gh(), detail, SESSION, 'preview', '  un cliente con 12 pedidos ', post);
    expect(post).toHaveBeenLastCalledWith('gho_user', 'acme/product', 849, '@ronin-agent /preview\n\nun cliente con 12 pedidos');
    await runAction(ENTRY, PR_REF, gh(), detail, SESSION, 'preview', 'un cliente\ncon 12 pedidos', post, APPS, 'backoffice');
    expect(post).toHaveBeenLastCalledWith('gho_user', 'acme/product', 849, '@ronin-agent /preview backoffice\n\nun cliente\ncon 12 pedidos');
    await expect(runAction(ENTRY, PR_REF, gh(), detail, SESSION, 'preview', '', post, APPS, 'otra')).rejects.toThrow('Falta la app');
    await runAction(ENTRY, PR_REF, gh(), detail, SESSION, 'auto-merge-on', undefined, post);
    expect(post).toHaveBeenLastCalledWith('gho_user', 'acme/product', 849, '@ronin-agent /auto-merge');
  });

  it('unblocks an issue: the answer as the person, the label by ronin', async () => {
    await runAction(ENTRY, { kind: 'issue', number: 844 }, gh(), undefined, SESSION, 'unblock', 'vamos con (b)', post);
    expect(post).toHaveBeenCalledWith('gho_user', 'acme/product', 844, 'vamos con (b)');
    expect(setIssueState).toHaveBeenCalledWith(844, 'in-progress');
  });

  it("refuses what isn't available or is missing its text, before commenting", async () => {
    await expect(runAction(ENTRY, PR_REF, gh(), detail, SESSION, 'unblock', 'x', post)).rejects.toBeInstanceOf(ActionError);
    await expect(runAction(ENTRY, { kind: 'issue', number: 844 }, gh(), undefined, SESSION, 'unblock', '   ', post)).rejects.toThrow('Falta el texto.');
    await expect(runAction(ENTRY, PR_REF, gh(), detail, SESSION, 'auto-merge-on', 'algo', post)).rejects.toThrow('no lleva texto');
    expect(post).not.toHaveBeenCalled();
  });

  it('assigns an issue to ronin as the person, after leaving the context as a plain comment', async () => {
    const done = await runAction(ENTRY, NEW_REF, unmanaged(), undefined, SESSION, 'assign', ' el caso es un cliente sin pedidos ', post, APPS, undefined, assign);
    expect(post).toHaveBeenCalledWith('gho_user', 'acme/product', 901, 'el caso es un cliente sin pedidos');
    expect(assign).toHaveBeenCalledWith('gho_user', 'acme/product', 901, ['ronin-agent']);
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0]);
    expect(done.url).toBe('https://github.com/acme/product/issues/901');
  });

  it('assigns without commenting when there is no context', async () => {
    await runAction(ENTRY, NEW_REF, unmanaged(), undefined, SESSION, 'assign', '', post, APPS, undefined, assign);
    expect(post).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledOnce();
  });

  it('writes a spike or a prototype with its app and instruction on one line', async () => {
    await runAction(ENTRY, NEW_REF, unmanaged(), undefined, SESSION, 'spike', 'de dónde sale\nel total', post, APPS, 'backoffice', assign);
    expect(post).toHaveBeenLastCalledWith('gho_user', 'acme/product', 901, '@ronin-agent /spike backoffice de dónde sale el total');
    await runAction(ENTRY, NEW_REF, unmanaged(), undefined, SESSION, 'prototype', undefined, post, APPS, 'webapp', assign);
    expect(post).toHaveBeenLastCalledWith('gho_user', 'acme/product', 901, '@ronin-agent /prototype webapp');
    expect(assign).not.toHaveBeenCalled();
  });

  it("refuses a spike on an app the repo doesn't have", async () => {
    await expect(runAction(ENTRY, NEW_REF, unmanaged(), undefined, SESSION, 'spike', '', post, APPS, 'otra', assign)).rejects.toThrow('Falta la app');
    expect(post).not.toHaveBeenCalled();
  });

  it('closes an issue as the person, after leaving the reason as a plain comment', async () => {
    const done = await runAction(ENTRY, NEW_REF, unmanaged(), undefined, SESSION, 'close-issue', '  Lo cubre otro issue ', post, [], undefined, assign, close);
    expect(post).toHaveBeenCalledWith('gho_user', 'acme/product', 901, 'Lo cubre otro issue');
    expect(close).toHaveBeenCalledWith('gho_user', 'acme/product', 901);
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    expect(done).toEqual({ url: 'https://github.com/acme/product/issues/844' });
  });

  it('closes without commenting when there is no reason', async () => {
    await runAction(ENTRY, NEW_REF, unmanaged(), undefined, SESSION, 'close-issue', '', post, [], undefined, assign, close);
    expect(post).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not close when GitHub refused the reason', async () => {
    post.mockRejectedValueOnce(new Error('403'));
    await expect(runAction(ENTRY, NEW_REF, unmanaged(), undefined, SESSION, 'close-issue', 'motivo', post, [], undefined, assign, close)).rejects.toThrow('403');
    expect(close).not.toHaveBeenCalled();
  });

  it('does not unblock when GitHub refused the comment', async () => {
    post.mockRejectedValueOnce(new Error('GitHub respondió 403'));
    await expect(runAction(ENTRY, { kind: 'issue', number: 844 }, gh(), undefined, SESSION, 'unblock', 'vamos', post)).rejects.toThrow('403');
    expect(setIssueState).not.toHaveBeenCalled();
  });
});
