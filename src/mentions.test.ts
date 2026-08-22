import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: { githubLogin: 'ronin' },
}));

const issueComments = vi.fn();
const reviewComments = vi.fn();
const botReaction = vi.fn();

vi.mock('./github.js', () => ({
  listIssueComments: (...args: unknown[]) => issueComments(...args),
  listReviewComments: (...args: unknown[]) => reviewComments(...args),
  hasBotReaction: (...args: unknown[]) => botReaction(...args),
}));

import { findUnprocessedMentions, isFixCommentsCommand, findTrustedFixCommentsCommand } from './mentions.js';

beforeEach(() => {
  issueComments.mockReset().mockResolvedValue([]);
  reviewComments.mockReset().mockResolvedValue([]);
  botReaction.mockReset().mockResolvedValue(false);
});

describe('findUnprocessedMentions', () => {
  it('returns an issue comment that mentions the handle and has no reactions yet', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: 'hey @ronin can you check this?', reactionsEyes: 0 },
      { id: 2, kind: 'issue', body: 'no mention here', reactionsEyes: 0 },
    ]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([{ id: 1, kind: 'issue', body: 'hey @ronin can you check this?', reactionsEyes: 0 }]);
  });

  it('matches the handle case-insensitively', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@Ronin please review', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toHaveLength(1);
  });

  it('includes inline review comments that mention the handle', async () => {
    reviewComments.mockResolvedValue([{ id: 5, kind: 'review', body: '@ronin fijate esta línea', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([{ id: 5, kind: 'review', body: '@ronin fijate esta línea', reactionsEyes: 0 }]);
  });

  it('excludes a mention already reacted to by the bot', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin revisá esto', reactionsEyes: 1 }]);
    botReaction.mockResolvedValue(true);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([]);
    expect(botReaction).toHaveBeenCalledWith(1, 'issue', 'ronin');
  });

  it('includes a mention with reactions from other users but not the bot', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin revisá esto', reactionsEyes: 1 }]);
    botReaction.mockResolvedValue(false);

    const result = await findUnprocessedMentions(42);
    expect(result).toHaveLength(1);
  });

  it('does not match a longer handle sharing the same prefix', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: 'cc @roninic-bot', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([]);
  });

  it('skips the extra reaction lookup when reactionsEyes is 0', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin revisá esto', reactionsEyes: 0 }]);

    await findUnprocessedMentions(42);
    expect(botReaction).not.toHaveBeenCalled();
  });
});

describe('isFixCommentsCommand', () => {
  it('matches the /fix-comments command', () => {
    expect(isFixCommentsCommand('@ronin-agent /fix-comments')).toBe(true);
  });

  it('matches the command case-insensitively', () => {
    expect(isFixCommentsCommand('@ronin-agent /FIX-Comments por favor')).toBe(true);
  });

  it('does not match a plain mention without the command', () => {
    expect(isFixCommentsCommand('@ronin-agent fijate este comentario')).toBe(false);
  });
});

describe('findTrustedFixCommentsCommand', () => {
  it('returns a /fix-comments issue comment from a trusted author', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorAssociation: 'MEMBER' },
    ]);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result).toEqual([{ id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorAssociation: 'MEMBER' }]);
  });

  it('accepts OWNER and COLLABORATOR too', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorAssociation: 'OWNER' },
      { id: 2, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorAssociation: 'COLLABORATOR' },
    ]);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result.map((c) => c.id)).toEqual([1, 2]);
  });

  it('excludes a /fix-comments comment from an untrusted author', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorAssociation: 'CONTRIBUTOR' },
    ]);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result).toEqual([]);
  });

  it('excludes a trusted comment that does not carry the command', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin can you take a look?', reactionsEyes: 0, authorAssociation: 'MEMBER' },
    ]);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result).toEqual([]);
  });

  it('excludes an inline review comment even from a trusted author', async () => {
    reviewComments.mockResolvedValue([
      { id: 5, kind: 'review', body: '@ronin /fix-comments', reactionsEyes: 0, authorAssociation: 'MEMBER' },
    ]);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result).toEqual([]);
  });

  it('excludes a command already reacted to by the bot', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 1, authorAssociation: 'MEMBER' },
    ]);
    botReaction.mockResolvedValue(true);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result).toEqual([]);
  });
});
