import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let base = '';
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', worktreeBasePath: base }) }));
const runAgentTask = vi.fn();
vi.mock('./agent-task.js', () => ({ runAgentTask: (...a: unknown[]) => runAgentTask(...a) }));
const addReaction = vi.fn();
const commentOnIssue = vi.fn();
const findOpenPrByHead = vi.fn();
const replyToComment = vi.fn();
vi.mock('./github.js', () => ({
  addReaction: (...a: unknown[]) => addReaction(...a),
  commentOnIssue: (...a: unknown[]) => commentOnIssue(...a),
  findOpenPrByHead: (...a: unknown[]) => findOpenPrByHead(...a),
  replyToComment: (...a: unknown[]) => replyToComment(...a),
}));
const publishArtifact = vi.fn();
vi.mock('./artifact-publisher.js', () => ({ publishArtifact: (...a: unknown[]) => publishArtifact(...a) }));
const startInterview = vi.fn();
vi.mock('./interview.js', () => ({ startInterview: (...a: unknown[]) => startInterview(...a) }));

import { processSpecCandidate } from './spec-flow.js';

const trigger = [{ id: 5, kind: 'issue' as const, body: '@ronin /spec backoffice', reactionsEyes: 0, authorLogin: 'someone' }];
const candidate = { issueNumber: 900, appName: 'backoffice', trigger };

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-spec-'));
  for (const m of [runAgentTask, addReaction, commentOnIssue, findOpenPrByHead, replyToComment, publishArtifact, startInterview]) m.mockReset();
  startInterview.mockResolvedValue(undefined);
  addReaction.mockResolvedValue(undefined);
  replyToComment.mockResolvedValue(undefined);
  commentOnIssue.mockResolvedValue(undefined);
  return () => rm(base, { recursive: true, force: true });
});

describe('processSpecCandidate', () => {
  it('publishes the mockup the agent left and links it on the spec PR', async () => {
    runAgentTask.mockImplementation(async (task: any) => {
      await mkdir(task.outDir, { recursive: true });
      await writeFile(join(task.outDir, 'mockup.html'), '<html></html>');
      return 'listo\nRONIN_STATUS: done';
    });
    findOpenPrByHead.mockResolvedValue({ number: 901 });
    publishArtifact.mockResolvedValue('https://claude.ai/artifact/m');

    await processSpecCandidate(candidate);

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'write-spec', issueNumber: 900, appName: 'backoffice' }));
    expect(findOpenPrByHead).toHaveBeenCalledWith('ronin/900/spec');
    expect(commentOnIssue).toHaveBeenCalledWith(901, 'Mockup de la propuesta: https://claude.ai/artifact/m');
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
