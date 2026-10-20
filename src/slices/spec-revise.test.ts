import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let base = '';
vi.mock('../core/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'acme/app', productRepoPath: '/repo', worktreeBasePath: base }) }));
const runAgentTask = vi.fn();
vi.mock('../core/agent-task.js', () => ({ runAgentTask: (...a: unknown[]) => runAgentTask(...a) }));
const setReviewStatus = vi.fn();
const commentOnIssue = vi.fn();
vi.mock('../core/github.js', () => ({ setReviewStatus: (...a: unknown[]) => setReviewStatus(...a), commentOnIssue: (...a: unknown[]) => commentOnIssue(...a) }));
const findUnprocessedMentions = vi.fn();
vi.mock('../commands/mentions.js', () => ({ findUnprocessedMentions: (...a: unknown[]) => findUnprocessedMentions(...a) }));
const markProcessed = vi.fn();
vi.mock('../core/processed-comments.js', () => ({ markProcessed: (...a: unknown[]) => markProcessed(...a) }));
vi.mock('../core/worktree.js', () => ({ ensureWorktree: vi.fn() }));
vi.mock('../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock('./prompts.js', () => ({ sliceTask: (task: unknown) => task }));
const publishMockup = vi.fn();
vi.mock('./spec-flow.js', () => ({ publishMockup: (...a: unknown[]) => publishMockup(...a) }));

const { draftSpecPrs, findSpecRevisionCandidates, processSpecRevision } = await import('./spec-revise.js');

const pr = (number: number, headRefName: string, isDraft = true) => ({ number, headRefName, isDraft }) as never;
const mention = (id: number, authorLogin = 'persona') => ({ id, kind: 'review' as const, body: '@ronin-agent cambiá esto', reactionsEyes: 0, authorLogin });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-spec-revise-'));
  for (const m of [runAgentTask, setReviewStatus, commentOnIssue, findUnprocessedMentions, markProcessed, publishMockup]) m.mockReset();
  setReviewStatus.mockResolvedValue(undefined);
  markProcessed.mockResolvedValue(undefined);
  return () => rm(base, { recursive: true, force: true });
});

describe('draftSpecPrs', () => {
  it('keeps only the draft PRs on a spec branch, with the issue they came from', () => {
    expect(draftSpecPrs([pr(10, 'ronin/9/spec'), pr(11, 'ronin/8/spec', false), pr(12, 'ronin/9/slice-1'), pr(13, 'feature/spec')])).toEqual([{ prNumber: 10, issueNumber: 9 }]);
  });
});

describe('findSpecRevisionCandidates', () => {
  it('lists the mentions left to answer on each draft spec PR, without the ones with no author', async () => {
    findUnprocessedMentions.mockImplementation(async (n: number) => (n === 10 ? [mention(1), mention(2, '')] : []));
    const out = await findSpecRevisionCandidates([pr(10, 'ronin/9/spec'), pr(20, 'ronin/19/spec')]);
    expect(out).toEqual([{ prNumber: 10, issueNumber: 9, mentions: [mention(1)] }]);
  });

  it('only looks at the PRs of an event, and a PR that fails to read leaves the rest', async () => {
    findUnprocessedMentions.mockImplementation(async (n: number) => {
      if (n === 10) throw new Error('gh');
      return [mention(3)];
    });
    expect(await findSpecRevisionCandidates([pr(10, 'ronin/9/spec'), pr(20, 'ronin/19/spec'), pr(30, 'ronin/29/spec')], [10, 20])).toEqual([{ prNumber: 20, issueNumber: 19, mentions: [mention(3)] }]);
  });
});

describe('processSpecRevision', () => {
  const candidate = { prNumber: 10, issueNumber: 9, mentions: [mention(1), mention(2)] };

  it('runs revise-spec on the spec and marks every mention done once it worked', async () => {
    runAgentTask.mockResolvedValue('listo');
    await processSpecRevision(candidate);
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'revise-spec', issueNumber: 9, prNumber: 10, mentions: candidate.mentions, outDir: join(base, 'spec-out', '9-revise') }));
    expect(setReviewStatus.mock.calls.map((c) => [c[1], c[3]])).toEqual([['pending', { context: 'ronin/spec' }], ['success', { context: 'ronin/spec' }]]);
    expect(markProcessed.mock.calls.map((c) => c[0].id)).toEqual([1, 2]);
    expect(commentOnIssue).not.toHaveBeenCalled();
  });

  it('shows a new mockup on the PR when the agent drew one', async () => {
    runAgentTask.mockImplementation(async (task: { outDir: string }) => {
      await mkdir(task.outDir, { recursive: true });
      await writeFile(join(task.outDir, 'mockup.html'), '<html></html>');
    });
    publishMockup.mockResolvedValue('https://img');
    await processSpecRevision(candidate);
    expect(publishMockup.mock.calls[0][0]).toBe(9);
    expect(commentOnIssue).toHaveBeenCalledWith(10, expect.stringContaining('<img src="https://img"'));
  });

  it('leaves the mentions unprocessed when the run fails, so the next tick tries again', async () => {
    runAgentTask.mockRejectedValue(new Error('timeout'));
    await processSpecRevision(candidate);
    expect(setReviewStatus.mock.calls.at(-1)?.[1]).toBe('error');
    expect(markProcessed).not.toHaveBeenCalled();
  });
});
