import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: { mentionHandle: 'valeria-agent', githubAppSlug: 'valeria' },
}));

const issueComments = vi.fn();
const reviewComments = vi.fn();
const botReaction = vi.fn();

vi.mock('./github.js', () => ({
  listIssueComments: (...args: unknown[]) => issueComments(...args),
  listReviewComments: (...args: unknown[]) => reviewComments(...args),
  hasBotReaction: (...args: unknown[]) => botReaction(...args),
}));

import { findUnprocessedMentions } from './mentions.js';

beforeEach(() => {
  issueComments.mockReset().mockResolvedValue([]);
  reviewComments.mockReset().mockResolvedValue([]);
  botReaction.mockReset().mockResolvedValue(false);
});

describe('findUnprocessedMentions', () => {
  it('returns an issue comment that mentions the handle and has no reactions yet', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: 'hey @valeria-agent can you check this?', reactionsEyes: 0 },
      { id: 2, kind: 'issue', body: 'no mention here', reactionsEyes: 0 },
    ]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([{ id: 1, kind: 'issue', body: 'hey @valeria-agent can you check this?', reactionsEyes: 0 }]);
  });

  it('matches the handle case-insensitively', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@Valeria-Agent please review', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toHaveLength(1);
  });

  it('includes inline review comments that mention the handle', async () => {
    reviewComments.mockResolvedValue([{ id: 5, kind: 'review', body: '@valeria-agent fijate esta línea', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([{ id: 5, kind: 'review', body: '@valeria-agent fijate esta línea', reactionsEyes: 0 }]);
  });

  it('excludes a mention already reacted to by the bot', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@valeria-agent revisá esto', reactionsEyes: 1 }]);
    botReaction.mockResolvedValue(true);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([]);
    expect(botReaction).toHaveBeenCalledWith(1, 'issue', 'valeria[bot]');
  });

  it('includes a mention with reactions from other users but not the bot', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@valeria-agent revisá esto', reactionsEyes: 1 }]);
    botReaction.mockResolvedValue(false);

    const result = await findUnprocessedMentions(42);
    expect(result).toHaveLength(1);
  });

  it('does not match a longer handle sharing the same prefix', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: 'cc @valeria-agentic-bot', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([]);
  });

  it('skips the extra reaction lookup when reactionsEyes is 0', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@valeria-agent revisá esto', reactionsEyes: 0 }]);

    await findUnprocessedMentions(42);
    expect(botReaction).not.toHaveBeenCalled();
  });
});
