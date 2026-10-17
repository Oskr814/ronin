import { describe, it, expect, vi, beforeEach } from 'vitest';

const setIssueState = vi.fn();
vi.mock('../../core/github.js', () => ({ setIssueState: (...args: unknown[]) => setIssueState(...args) }));
vi.mock('../../core/config.js', () => ({ config: { githubLogin: 'ronin-agent' }, LABEL_AUTO_MERGE: 'ronin:auto-merge' }));
vi.mock('../../core/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../core/repo-context.js', () => ({ withActiveRepo: (_entry: unknown, fn: () => unknown) => fn() }));

const { listActions, actionComment, runAction, ActionError } = await import('./dashboard-actions.js');

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
const PR_REF = { kind: 'pr' as const, number: 849, issue: 844 };
const ids = (actions: Array<{ id: string }>) => actions.map((a) => a.id);

beforeEach(() => {
  setIssueState.mockReset();
  post.mockReset().mockResolvedValue({ id: 77, url: 'https://github.com/acme/product/pull/849#issuecomment-77' });
});

describe('listActions', () => {
  it("offers a PR's commands, resolving conflicts first when it has them", () => {
    const actions = listActions(PR_REF, gh(), { fetchedAt: '', pr: discussion(849, { mergeable: 'CONFLICTING' }) }, 'Oskr814');
    expect(ids(actions)).toEqual(['resolve-conflicts', 'preview', 'auto-merge-on']);
    expect(actions[0]).toMatchObject({ primary: true, target: 849 });
  });

  it('offers to stop a preview that is up, and auto-merge off when its label is on', () => {
    const actions = listActions(PR_REF, gh({ previews: [{ prNumber: 849, appName: 'backoffice', url: '' }] }), { fetchedAt: '', pr: discussion(849, { labels: ['ronin:auto-merge'] }) }, 'Oskr814');
    expect(ids(actions)).toEqual(['resolve-conflicts', 'preview', 'preview-stop', 'auto-merge-off']);
    expect(actions[0].primary).toBe(false);
  });

  it("gives a blocked issue the way to unblock it, and its PR's commands aimed at the PR", () => {
    const actions = listActions({ kind: 'issue', number: 844, pr: 849 }, gh(), undefined, 'Oskr814');
    expect(ids(actions)).toEqual(['unblock', 'resolve-conflicts', 'preview', 'auto-merge-on']);
    expect(actions[0]).toMatchObject({ target: 844, text: { required: true }, preview: '…' });
    expect(actions[1]).toMatchObject({ target: 849, label: 'Resolver conflictos en #849' });
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

  it('does not unblock when GitHub refused the comment', async () => {
    post.mockRejectedValueOnce(new Error('GitHub respondió 403'));
    await expect(runAction(ENTRY, { kind: 'issue', number: 844 }, gh(), undefined, SESSION, 'unblock', 'vamos', post)).rejects.toThrow('403');
    expect(setIssueState).not.toHaveBeenCalled();
  });
});
