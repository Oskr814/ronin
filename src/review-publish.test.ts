import { describe, it, expect, vi, beforeEach } from 'vitest';

const mkdir = vi.fn();
const readFile = vi.fn();
const rm = vi.fn();
const writeFile = vi.fn();
vi.mock('node:fs/promises', () => ({ mkdir, readFile, rm, writeFile }));

const runAgentTask = vi.fn();
vi.mock('./agent-task.js', () => ({ runAgentTask }));

const postReview = vi.fn();
const resolveReviewThread = vi.fn();
const replyToComment = vi.fn();
vi.mock('./github.js', () => ({ postReview, resolveReviewThread, replyToComment }));

vi.mock('./repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/wt' }),
}));

const loadReviewCriteria = vi.fn();
vi.mock('./review-criteria.js', () => ({ loadReviewCriteria }));

const commentableLines = vi.fn();
vi.mock('./review-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./review-scope.js')>()),
  commentableLines,
}));

const logInfo = vi.fn();
const logError = vi.fn();
const logMetric = vi.fn();
vi.mock('./logger.js', () => ({ log: { info: logInfo, error: logError, metric: logMetric } }));

const { runExternalReview, threadTitle, closingState } = await import('./review-publish.js');

const OUTPUT_PATH = '/tmp/wt/external-review-out/305-abc123def.json';

const candidate = {
  prNumber: 305,
  headRefName: 'feat/x',
  headSha: 'abc123def',
  baseRefName: 'odoo-main',
  openThreads: [
    { id: 'T1', body: '<!-- marker -->\n### 🟠 **Carrera en X**\n...', url: 'https://github.com/x/pull/305#discussion_r1' },
    { id: 'T2', body: '### 🟡 **Otro**', url: 'https://github.com/x/pull/305#discussion_r2' },
  ],
  mentions: [{ id: 42, kind: 'issue' as const, body: '@ronin mirá', reactionsEyes: 0, authorLogin: 'dev' }],
};

function finding(overrides: Record<string, unknown> = {}) {
  return {
    path: 'src/a.ts',
    line: 11,
    type: 'bug',
    severity: 'important',
    category: 'Bug',
    title: 'Hallazgo',
    scenario: 'Dado A, cuando B, pasa C.',
    impact: 'Rompe algo.',
    evidence: [],
    verification: { status: 'reasoned' },
    affectedCode: 'x();',
    ...overrides,
  };
}

function agentWrites(output: unknown) {
  readFile.mockResolvedValue(JSON.stringify(output));
}

beforeEach(() => {
  vi.clearAllMocks();
  loadReviewCriteria.mockResolvedValue({ text: '# Criterio', blobHash: 'cafebabe00' });
  commentableLines.mockResolvedValue(new Map([['src/a.ts', new Set([10, 11, 12])]]));
  runAgentTask.mockResolvedValue('');
  mkdir.mockResolvedValue(undefined);
  rm.mockResolvedValue(undefined);
  writeFile.mockResolvedValue(undefined);
  postReview.mockResolvedValue(undefined);
  resolveReviewThread.mockResolvedValue(undefined);
  replyToComment.mockResolvedValue(undefined);
});

describe('runExternalReview — running the agent', () => {
  it('passes the criteria and an output path outside the worktree, clearing any leftover first', async () => {
    agentWrites({});

    await runExternalReview(candidate);

    expect(mkdir).toHaveBeenCalledWith('/tmp/wt/external-review-out', { recursive: true });
    expect(rm).toHaveBeenCalledWith(OUTPUT_PATH, { force: true });
    expect(rm.mock.invocationCallOrder[0]).toBeLessThan(runAgentTask.mock.invocationCallOrder[0]);
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'external-review',
      prNumber: 305,
      headSha: 'abc123def',
      criteriaText: '# Criterio',
      outputPath: OUTPUT_PATH,
    }));
  });

  it('fails the task when the agent wrote no output, and still cleans up', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));

    await expect(runExternalReview(candidate)).rejects.toThrow('no escribió');
    expect(postReview).not.toHaveBeenCalled();
    expect(rm).toHaveBeenLastCalledWith(OUTPUT_PATH, { force: true });
  });

  it('fails the task when the output is not valid JSON', async () => {
    readFile.mockResolvedValue('{ nope');

    await expect(runExternalReview(candidate)).rejects.toThrow();
    expect(postReview).not.toHaveBeenCalled();
  });

  it('propagates an agent failure without publishing anything', async () => {
    runAgentTask.mockRejectedValue(new Error('timeout'));

    await expect(runExternalReview(candidate)).rejects.toThrow('timeout');
    expect(postReview).not.toHaveBeenCalled();
    expect(rm).toHaveBeenLastCalledWith(OUTPUT_PATH, { force: true });
  });
});

describe('runExternalReview — publishing', () => {
  it('posts one COMMENT-only review pinned to the head, with inline comments and a summary body', async () => {
    agentWrites({ findings: [finding(), finding({ path: 'docs/far.md', line: 3, title: 'Fuera' })] });

    await runExternalReview(candidate);

    expect(postReview).toHaveBeenCalledTimes(1);
    const [prNumber, review] = postReview.mock.calls[0];
    expect(prNumber).toBe(305);
    expect(review.commitId).toBe('abc123def');
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: 'src/a.ts', line: 11 });
    expect(review.comments[0].body).toMatch(/^<!-- ronin:finding v=2 type=bug .* criteria=cafebabe00 -->/);
    expect(review.body).toContain('## Review de ronin');
    expect(review.body).toContain('### Fuera del diff');
    expect(review.body).toContain('Fuera');
  });

  it('computes commentable lines against the PR base branch', async () => {
    agentWrites({ findings: [finding()] });

    await runExternalReview(candidate);

    expect(commentableLines).toHaveBeenCalledWith('abc123def', 'odoo-main');
  });

  it('resolves the threads the agent reported as addressed, before posting the review', async () => {
    agentWrites({ resolveThreads: [{ threadId: 'T1', reason: 'arreglado' }] });

    await runExternalReview(candidate);

    expect(resolveReviewThread).toHaveBeenCalledWith('T1');
    expect(resolveReviewThread.mock.invocationCallOrder[0]).toBeLessThan(postReview.mock.invocationCallOrder[0]);
  });

  it('keeps going when one thread resolution fails', async () => {
    resolveReviewThread.mockRejectedValueOnce(new Error('graphql'));
    agentWrites({ resolveThreads: [{ threadId: 'T1', reason: 'a' }, { threadId: 'T2', reason: 'b' }] });

    await runExternalReview(candidate);

    expect(resolveReviewThread).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalled();
    expect(postReview).toHaveBeenCalled();
  });

  it('never resolves a thread that is not one of the bot\'s open threads', async () => {
    agentWrites({ resolveThreads: [{ threadId: 'HUMAN', reason: 'x' }] });

    await runExternalReview(candidate);

    expect(resolveReviewThread).not.toHaveBeenCalled();
  });

  it('closes with the list of still-open threads instead of LGTM', async () => {
    agentWrites({ resolveThreads: [{ threadId: 'T1', reason: 'arreglado' }] });

    await runExternalReview(candidate);

    const review = postReview.mock.calls[0][1];
    expect(review.comments).toEqual([]);
    expect(review.body).toBe('Sin observaciones nuevas; queda 1 abierta:\n\n- [🟡 Otro](https://github.com/x/pull/305#discussion_r2)');
  });

  it('confirms the fixes when every open thread was resolved', async () => {
    agentWrites({ resolveThreads: [{ threadId: 'T1', reason: 'a' }, { threadId: 'T2', reason: 'b' }] });

    await runExternalReview(candidate);

    expect(postReview.mock.calls[0][1].body).toBe('✅ Ajustes confirmados, no quedan observaciones pendientes.');
  });

  it('says LGTM only when there was nothing open and nothing new', async () => {
    agentWrites({});

    await runExternalReview({ ...candidate, openThreads: [] });

    expect(postReview.mock.calls[0][1].body).toBe('LGTM 🚀');
  });

  it('replies to each mention with mentions neutralized', async () => {
    agentWrites({ mentionReplies: [{ commentId: 42, kind: 'issue', body: 'Revisé lo que pidió @dev' }] });

    await runExternalReview(candidate);

    expect(replyToComment).toHaveBeenCalledWith(305, { id: 42, kind: 'issue' }, 'Revisé lo que pidió @‍dev');
  });

  it('logs every finding dropped by validation', async () => {
    agentWrites({ findings: [finding({ type: 'nope' }), finding()] });

    await runExternalReview(candidate);

    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('type inválido'));
    expect(postReview.mock.calls[0][1].comments).toHaveLength(1);
  });

  it('records a metric for the published review', async () => {
    agentWrites({ findings: [finding()] });

    await runExternalReview(candidate);

    expect(logMetric).toHaveBeenCalledWith('external_review_published', expect.objectContaining({ prNumber: 305, findings: 1, inline: 1, outOfDiff: 0, dryRun: false }));
  });
});

describe('runExternalReview — dry run', () => {
  it('writes everything to a Markdown file and publishes nothing', async () => {
    agentWrites({ findings: [finding()], resolveThreads: [{ threadId: 'T1', reason: 'arreglado' }], mentionReplies: [{ commentId: 42, kind: 'issue', body: 'ok' }] });

    await runExternalReview(candidate, { dryRun: { outFile: 'logs/dry-run/305.md' } });

    expect(postReview).not.toHaveBeenCalled();
    expect(resolveReviewThread).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [file, content] = writeFile.mock.calls[0];
    expect(file).toBe('logs/dry-run/305.md');
    expect(content).toContain('# Dry-run: PR #305 @ abc123d');
    expect(content).toContain('## Comentario en `src/a.ts:11`');
    expect(content).toContain('T1: arreglado');
    expect(content).toContain('## Respuesta a la mención 42');
  });
});

describe('helpers', () => {
  it('threadTitle takes the first heading of a bot thread', () => {
    expect(threadTitle('<!-- m -->\n### 🟠 **Carrera en X**\nmore')).toBe('🟠 Carrera en X');
    expect(threadTitle('sin heading')).toBe('Observación abierta');
  });

  it('closingState falls back to the PR URL when a thread has no link', () => {
    expect(closingState([{ id: 'T', body: '### A' }], new Set(), 'https://pr')).toEqual({ open: [{ url: 'https://pr', title: 'A' }] });
  });
});
