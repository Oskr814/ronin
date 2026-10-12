import { describe, it, expect, vi, beforeEach } from 'vitest';

let interviews: Record<string, any> = {};
const cfg = vi.hoisted(() => ({ remoteInterviews: true, interviewTimeoutHours: 24, githubLogin: 'ronin-agent', githubToken: 't', agentModel: 'opus' }));
vi.mock('./config.js', () => ({ config: cfg }));
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', productRepoPath: '/repo' }) }));
const addPendingSpec = vi.hoisted(() => vi.fn());
vi.mock('./local-state.js', () => ({
  addPendingSpec: (...a: unknown[]) => addPendingSpec(...a),
  getInterviews: async () => ({ ...interviews }),
  setInterview: async (n: number, v: unknown) => { if (v) interviews[n] = v; else delete interviews[n]; },
}));
const commentOnIssue = vi.fn();
const listIssueComments = vi.fn();
const setIssueState = vi.fn();
vi.mock('./github.js', () => ({
  commentOnIssue: (...a: unknown[]) => commentOnIssue(...a),
  listIssueComments: (...a: unknown[]) => listIssueComments(...a),
  setIssueState: (...a: unknown[]) => setIssueState(...a),
}));
const notifyBlocker = vi.fn();
vi.mock('./notifier.js', () => ({ notifyBlocker: (...a: unknown[]) => notifyBlocker(...a) }));
const startBackgroundSession = vi.fn();
const sessionLogs = vi.fn();
const sessionState = vi.fn();
const removeSession = vi.fn();
vi.mock('./bg-session.js', () => ({
  startBackgroundSession: (...a: unknown[]) => startBackgroundSession(...a),
  sessionLogs: (...a: unknown[]) => sessionLogs(...a),
  sessionState: (...a: unknown[]) => sessionState(...a),
  removeSession: (...a: unknown[]) => removeSession(...a),
}));

import { answersMarker, checkInterviews, interviewPrompt, startInterview } from './interview.js';

beforeEach(() => {
  interviews = {};
  cfg.remoteInterviews = true;
  for (const m of [commentOnIssue, listIssueComments, setIssueState, notifyBlocker, startBackgroundSession, sessionLogs, sessionState, removeSession]) m.mockReset();
  startBackgroundSession.mockResolvedValue('abc123');
  sessionLogs.mockResolvedValue('/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_01Fwzd');
  sessionState.mockResolvedValue({ status: 'idle', state: 'done' });
  listIssueComments.mockResolvedValue([]);
});

describe('startInterview', () => {
  it('opens a Remote Control session scoped to the issue, links it there and emails it', async () => {
    await startInterview(812, 'https://github.com/o/r/issues/812');

    const opts = startBackgroundSession.mock.calls[0][0];
    expect(opts).toMatchObject({ remoteControl: true, permissionMode: 'default', addDirs: ['/repo'], env: { GH_TOKEN: 't', GH_REPO: 'redmotos/shoppingcart' } });
    expect(opts.allowedTools).toEqual(['Bash(gh issue view 812:*)', 'Bash(gh issue comment 812:*)', 'Read', 'Grep', 'Glob']);
    expect(commentOnIssue.mock.calls[0][1]).toContain('https://claude.ai/code/session_01Fwzd');
    expect(notifyBlocker).toHaveBeenCalledWith(expect.objectContaining({ excerpt: expect.stringContaining('session_01Fwzd') }));
    expect(interviews[812]).toMatchObject({ sessionId: 'abc123', url: 'https://claude.ai/code/session_01Fwzd' });
    expect(opts.prompt).toContain(answersMarker(interviews[812].nonce));
  });

  it('does nothing when disabled or already open for the issue', async () => {
    cfg.remoteInterviews = false;
    await startInterview(812, 'u');
    cfg.remoteInterviews = true;
    interviews[812] = { sessionId: 'x', startedAt: new Date().toISOString() };
    await startInterview(812, 'u');
    expect(startBackgroundSession).not.toHaveBeenCalled();
  });
});

describe('interviewPrompt', () => {
  it('reads the issue, interviews in Spanish and posts answers ending with the marker', () => {
    const prompt = interviewPrompt(812, 'n0nce');
    expect(prompt).toContain('gh issue view 812 --comments');
    expect(prompt).toContain('Spanish');
    expect(prompt).toContain('<!-- ronin:respuestas n0nce -->');
  });
});

describe('checkInterviews', () => {
  const now = new Date('2026-10-12T12:00:00Z');

  it('closes an answered interview and puts the issue back in progress', async () => {
    interviews[812] = { sessionId: 'abc', startedAt: '2026-10-12T10:00:00Z', nonce: 'n1' };
    listIssueComments.mockResolvedValue([{ authorLogin: 'ronin-agent', body: `## Respuestas\n...\n${answersMarker('n1')}` }]);
    await checkInterviews(now);
    expect(removeSession).toHaveBeenCalledWith('abc');
    expect(setIssueState).toHaveBeenCalledWith(812, 'in-progress');
    expect(interviews[812]).toBeUndefined();
  });

  it('redoes the /spec instead of touching the issue state when that is what waited', async () => {
    interviews[812] = { sessionId: 'abc', startedAt: '2026-10-12T10:00:00Z', nonce: 'n1', resume: { kind: 'spec', appName: 'backoffice' } };
    listIssueComments.mockResolvedValue([{ authorLogin: 'ronin-agent', body: answersMarker('n1') }]);
    await checkInterviews(now);
    expect(addPendingSpec).toHaveBeenCalledWith({ issueNumber: 812, appName: 'backoffice' });
    expect(setIssueState).not.toHaveBeenCalled();
  });

  it('ignores a marker someone else posted, or another interview’s', async () => {
    interviews[812] = { sessionId: 'abc', startedAt: '2026-10-12T10:00:00Z', nonce: 'n1' };
    listIssueComments.mockResolvedValue([
      { authorLogin: 'someone', body: answersMarker('n1') },
      { authorLogin: 'ronin-agent', body: answersMarker('otro') },
    ]);
    await checkInterviews(now);
    expect(setIssueState).not.toHaveBeenCalled();
    expect(interviews[812]).toBeDefined();
  });

  it('closes an expired interview and says so on the issue', async () => {
    interviews[812] = { sessionId: 'abc', startedAt: '2026-10-11T08:00:00Z', nonce: 'n1' };
    await checkInterviews(now);
    expect(removeSession).toHaveBeenCalledWith('abc');
    expect(commentOnIssue.mock.calls[0][1]).toContain('Cerré la conversación');
    expect(setIssueState).not.toHaveBeenCalled();
  });

  it('forgets an interview whose session is already gone', async () => {
    interviews[812] = { sessionId: 'abc', startedAt: '2026-10-12T10:00:00Z', nonce: 'n1' };
    sessionState.mockResolvedValue(null);
    await checkInterviews(now);
    expect(interviews[812]).toBeUndefined();
    expect(removeSession).not.toHaveBeenCalled();
  });
});
