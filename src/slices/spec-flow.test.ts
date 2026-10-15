import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let base = '';
vi.mock('../core/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', productRepoPath: '/repo', worktreeBasePath: base }) }));
const runAgentTask = vi.fn();
vi.mock('../core/agent-task.js', () => ({ runAgentTask: (...a: unknown[]) => runAgentTask(...a) }));
const addReaction = vi.fn();
const commentOnIssue = vi.fn();
const findOpenPrByHead = vi.fn();
const replyToComment = vi.fn();
vi.mock('../core/github.js', () => ({
  addReaction: (...a: unknown[]) => addReaction(...a),
  commentOnIssue: (...a: unknown[]) => commentOnIssue(...a),
  findOpenPrByHead: (...a: unknown[]) => findOpenPrByHead(...a),
  replyToComment: (...a: unknown[]) => replyToComment(...a),
}));
const renderHtmlToPng = vi.fn();
vi.mock('../app/browser.js', () => ({ renderHtmlToPng: (...a: unknown[]) => renderHtmlToPng(...a) }));
const publishEvidence = vi.fn();
vi.mock('../app/evidence-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app/evidence-store.js')>()),
  publishEvidence: (...a: unknown[]) => publishEvidence(...a),
}));
const startInterview = vi.fn();
vi.mock('./interview.js', () => ({ startInterview: (...a: unknown[]) => startInterview(...a) }));

import { processSpecCandidate } from './spec-flow.js';

const trigger = [{ id: 5, kind: 'issue' as const, body: '@ronin /spec backoffice', reactionsEyes: 0, authorLogin: 'someone' }];
const candidate = { issueNumber: 900, appName: 'backoffice', trigger };

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-spec-'));
  for (const m of [runAgentTask, addReaction, commentOnIssue, findOpenPrByHead, replyToComment, renderHtmlToPng, publishEvidence, startInterview]) m.mockReset();
  startInterview.mockResolvedValue(undefined);
  addReaction.mockResolvedValue(undefined);
  replyToComment.mockResolvedValue(undefined);
  commentOnIssue.mockResolvedValue(undefined);
  return () => rm(base, { recursive: true, force: true });
});

describe('processSpecCandidate', () => {
  it('renders the mockup the agent left, pushes it to the evidence branch and shows it on the spec PR', async () => {
    runAgentTask.mockImplementation(async (task: any) => {
      await mkdir(task.outDir, { recursive: true });
      await writeFile(join(task.outDir, 'mockup.html'), '<html></html>');
      return 'listo\nRONIN_STATUS: done';
    });
    findOpenPrByHead.mockResolvedValue({ number: 901 });
    renderHtmlToPng.mockResolvedValue(undefined);
    publishEvidence.mockResolvedValue('abc123');

    await processSpecCandidate(candidate);

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'write-spec', issueNumber: 900, appName: 'backoffice' }));
    expect(findOpenPrByHead).toHaveBeenCalledWith('ronin/900/spec');
    expect(renderHtmlToPng.mock.calls[0][0]).toBe(join(base, 'spec-out', '900', 'mockup.html'));
    const [repoDir, files] = publishEvidence.mock.calls[0];
    expect(repoDir).toBe('/repo');
    expect(files[0].path).toMatch(/^specs\/900\/mockup-\d+\.png$/);
    expect(commentOnIssue.mock.calls[0][0]).toBe(901);
    expect(commentOnIssue.mock.calls[0][1]).toContain(`<img src="https://github.com/redmotos/shoppingcart/blob/abc123/${files[0].path}?raw=true"`);
    expect(addReaction).toHaveBeenCalledWith(5, 'issue', 'eyes');
  });

  it('opens an interview that redoes the /spec when the agent needs info', async () => {
    runAgentTask.mockResolvedValue('Pregunté en el issue.\nRONIN_STATUS: needs-info');
    await processSpecCandidate({ ...candidate, instruction: 'para bodega' });
    expect(startInterview).toHaveBeenCalledWith(900, 'https://github.com/redmotos/shoppingcart/issues/900', { kind: 'spec', appName: 'backoffice', instruction: 'para bodega' });
    expect(findOpenPrByHead).not.toHaveBeenCalled();
  });

  it('answers and reacts on failure instead of retrying every tick', async () => {
    runAgentTask.mockRejectedValue(new Error('timeout\nstack'));
    await processSpecCandidate(candidate);
    expect(replyToComment.mock.calls[0][2]).toContain('No pude escribir el spec: timeout.');
    expect(addReaction).toHaveBeenCalledWith(5, 'issue', 'eyes');
  });
});
