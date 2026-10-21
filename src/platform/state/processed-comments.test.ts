import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/config.js', () => ({ config: { githubLogin: 'ronin' } }));

const botReactedBefore = vi.fn();
const addReaction = vi.fn();
vi.mock('../github/github.js', () => ({
  botReactedBefore: (...args: unknown[]) => botReactedBefore(...args),
  addReaction: (...args: unknown[]) => addReaction(...args),
}));

let done = new Set<string>();
const recordProcessedComment = vi.fn();
vi.mock('./local-state.js', () => ({
  getProcessedComments: async () => done,
  recordProcessedComment: (...args: unknown[]) => recordProcessedComment(...args),
}));

const { unprocessed, markProcessed, ACK_EYES_SINCE } = await import('./processed-comments.js');

const comment = (id: number, createdAt: string, reactionsEyes = 0) => ({ id, kind: 'issue' as const, createdAt, reactionsEyes });

beforeEach(() => {
  done = new Set();
  botReactedBefore.mockReset().mockResolvedValue(false);
  addReaction.mockReset().mockResolvedValue(undefined);
  recordProcessedComment.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
});

describe('unprocessed', () => {
  it('leaves out what is recorded as done', async () => {
    done.add('issue-1');
    const result = await unprocessed([comment(1, '2026-10-19T00:00:00Z', 1), comment(2, '2026-10-19T00:00:00Z')]);
    expect(result.map((c) => c.id)).toEqual([2]);
  });

  it("does not take ronin's 👀 on a new comment for done, with nothing read from the state yet: it only says it got it", async () => {
    const result = await unprocessed([comment(3, '2026-10-19T00:00:00Z', 1)]);
    expect(result.map((c) => c.id)).toEqual([3]);
    expect(botReactedBefore).not.toHaveBeenCalled();
  });

  it("counts a comment from before the 👀-as-ack switch as done when ronin's 👀 on it predates the switch", async () => {
    botReactedBefore.mockImplementation(async (id: number) => id === 4);
    const result = await unprocessed([comment(4, '2026-10-15T00:00:00Z', 1), comment(5, '2026-10-15T00:00:00Z', 1), comment(6, '2026-10-15T00:00:00Z')]);
    expect(result.map((c) => c.id)).toEqual([5, 6]);
    expect(botReactedBefore).toHaveBeenCalledWith(4, 'issue', 'ronin', ACK_EYES_SINCE);
  });

  it('answers a comment whose 👀 came seconds after the switch (regression: /help on #849)', async () => {
    // Created 01:06:33, ronin's "got it" 👀 at 01:06:35: still to do.
    const result = await unprocessed([comment(6205676051, '2026-10-16T01:06:33Z', 1)]);
    expect(result.map((c) => c.id)).toEqual([6205676051]);
    expect(botReactedBefore).not.toHaveBeenCalled();
  });

  it('counts a comment older than half a year as done', async () => {
    expect(await unprocessed([comment(7, '2026-03-01T00:00:00Z')])).toEqual([]);
  });
});

describe('markProcessed', () => {
  it('records the comment and makes sure of its 👀', async () => {
    await markProcessed({ id: 8, kind: 'review' });
    expect(recordProcessedComment).toHaveBeenCalledWith('review-8', expect.any(Number));
    expect(addReaction).toHaveBeenCalledWith(8, 'review', 'eyes');
  });
});
