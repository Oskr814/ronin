import { describe, it, expect, vi, beforeEach } from 'vitest';

const postIssueComment = vi.fn();
const setIssueState = vi.fn();
const launchConflictsWorker = vi.fn();
const launchPreviewWorker = vi.fn();
const applyAutoMergeCommand = vi.fn();
vi.mock('../../core/github.js', () => ({
  postIssueComment: (...args: unknown[]) => postIssueComment(...args),
  setIssueState: (...args: unknown[]) => setIssueState(...args),
}));
vi.mock('../../commands/conflicts.js', () => ({ launchConflictsWorker: (...args: unknown[]) => launchConflictsWorker(...args) }));
vi.mock('../../preview/preview.js', () => ({ launchPreviewWorker: (...args: unknown[]) => launchPreviewWorker(...args) }));
vi.mock('../../commands/auto-merge.js', () => ({ applyAutoMergeCommand: (...args: unknown[]) => applyAutoMergeCommand(...args) }));
vi.mock('../../core/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../core/repo-context.js', () => ({ withActiveRepo: (_entry: unknown, fn: () => unknown) => fn() }));

const { listActions, actionComment, runAction, ActionError } = await import('./dashboard-actions.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' };
const pr = (number: number) => ({ number, title: '', url: '', author: 'ronin-agent', isDraft: false, headRefName: 'ronin/844/slice-1', baseRefName: 'odoo-main', reviewDecision: '' as const, checks: [] });
const gh = (over: Record<string, unknown> = {}) => ({
  repo: 'acme/product', fetchedAt: '', blocks: {}, previews: [],
  issues: [{ number: 844, title: '', url: '', status: 'blocked' as const, direct: false, slices: [] }],
  prs: [pr(849)],
  ...over,
});
const discussion = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: '', body: '', author: '', createdAt: '', url: '', state: 'OPEN', labels: [], comments: [], ...extra });
const PR_REF = { kind: 'pr' as const, number: 849, issue: 844 };
const ids = (actions: Array<{ id: string }>) => actions.map((a) => a.id);

beforeEach(() => {
  for (const fn of [postIssueComment, setIssueState, launchConflictsWorker, launchPreviewWorker, applyAutoMergeCommand]) fn.mockReset();
  postIssueComment.mockResolvedValue({ id: 77, url: 'https://github.com/acme/product/pull/849#issuecomment-77' });
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
    expect(actions[0]).toMatchObject({ target: 844, text: { required: true }, preview: expect.stringContaining('> …') });
    expect(actions[1]).toMatchObject({ target: 849, label: 'Resolver conflictos en #849' });
  });

  it('offers nothing for a PR that is no longer open', () => {
    expect(listActions(PR_REF, gh({ prs: [] }), undefined, 'Oskr814')).toEqual([]);
  });
});

describe('actionComment', () => {
  it('names who asked and the command, without mentioning ronin', () => {
    expect(actionComment({ id: 'resolve-conflicts', command: '/resolve-conflicts' }, 'Oskr814')).toBe('**Oskr814** pidió `/resolve-conflicts` desde el tablero.');
    expect(actionComment({ id: 'unblock', command: '' }, 'Oskr814', 'vamos con (b)\nsin fecha')).toBe('**Oskr814** respondió desde el tablero:\n\n> vamos con (b)\n> sin fecha\n\nLo vuelvo a pasar a `ronin:in-progress`.');
  });
});

describe('runAction', () => {
  const detail = { fetchedAt: '', pr: discussion(849, { mergeable: 'CONFLICTING' }) };

  it("comments first and hands that comment to the command's worker", async () => {
    const done = await runAction(ENTRY, PR_REF, gh(), detail, 'Oskr814', 'resolve-conflicts');
    expect(postIssueComment).toHaveBeenCalledWith(849, '**Oskr814** pidió `/resolve-conflicts` desde el tablero.');
    expect(launchConflictsWorker).toHaveBeenCalledWith({ repo: 'acme/product', prNumber: 849, comment: { id: 77, kind: 'issue' } });
    expect(done.url).toContain('issuecomment-77');
  });

  it('passes what to prepare to the preview, and turns auto-merge on through its own command', async () => {
    await runAction(ENTRY, PR_REF, gh(), detail, 'Oskr814', 'preview', '  un cliente con 12 pedidos ');
    expect(launchPreviewWorker).toHaveBeenCalledWith({ repo: 'acme/product', prNumber: 849, action: 'up', args: 'un cliente con 12 pedidos', comment: { id: 77, kind: 'issue' } });
    await runAction(ENTRY, PR_REF, gh(), detail, 'Oskr814', 'auto-merge-on');
    expect(applyAutoMergeCommand).toHaveBeenCalledWith(849, { id: 77, kind: 'issue' }, 'on');
  });

  it('unblocks an issue with the answer as its comment', async () => {
    await runAction(ENTRY, { kind: 'issue', number: 844 }, gh(), undefined, 'Oskr814', 'unblock', 'vamos con (b)');
    expect(postIssueComment).toHaveBeenCalledWith(844, expect.stringContaining('> vamos con (b)'));
    expect(setIssueState).toHaveBeenCalledWith(844, 'in-progress');
  });

  it("refuses what isn't available or is missing its text, before commenting", async () => {
    await expect(runAction(ENTRY, PR_REF, gh(), detail, 'Oskr814', 'unblock', 'x')).rejects.toBeInstanceOf(ActionError);
    await expect(runAction(ENTRY, { kind: 'issue', number: 844 }, gh(), undefined, 'Oskr814', 'unblock', '   ')).rejects.toThrow('Falta el texto.');
    await expect(runAction(ENTRY, PR_REF, gh(), detail, 'Oskr814', 'auto-merge-on', 'algo')).rejects.toThrow('no lleva texto');
    expect(postIssueComment).not.toHaveBeenCalled();
  });
});
