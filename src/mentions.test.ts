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

import {
  findUnprocessedMentions,
  isFixCommentsCommand,
  findTrustedFixCommentsCommand,
  isSpikeCommand,
  parseSpikeCommand,
  findUnprocessedIssueMentions,
  findTrustedSpikeCommand,
} from './mentions.js';

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
  it('returns a /fix-comments issue comment from any author with a real login', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' },
    ]);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result).toEqual([{ id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' }]);
  });

  it('excludes a comment that does not carry the command', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin can you take a look?', reactionsEyes: 0, authorLogin: 'someone' },
    ]);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result).toEqual([]);
  });

  it('includes an inline review comment carrying the command', async () => {
    reviewComments.mockResolvedValue([
      { id: 5, kind: 'review', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' },
    ]);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result).toEqual([{ id: 5, kind: 'review', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' }]);
  });

  it('excludes a command already reacted to by the bot', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 1, authorLogin: 'someone' },
    ]);
    botReaction.mockResolvedValue(true);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result).toEqual([]);
  });

  it('excludes a comment with no author (deleted/ghost account)', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: '' },
    ]);

    const result = await findTrustedFixCommentsCommand(42);
    expect(result).toEqual([]);
  });
});

describe('isSpikeCommand', () => {
  it('matches the /spike command', () => {
    expect(isSpikeCommand('@ronin /spike backoffice')).toBe(true);
  });

  it('matches the command case-insensitively', () => {
    expect(isSpikeCommand('@ronin /SPIKE backoffice')).toBe(true);
  });

  it('does not match a plain mention without the command', () => {
    expect(isSpikeCommand('@ronin can you look at this?')).toBe(false);
  });
});

describe('parseSpikeCommand', () => {
  it('parses the app_name with no instruction', () => {
    expect(parseSpikeCommand('@ronin /spike backoffice')).toEqual({ appName: 'backoffice', instruction: undefined });
  });

  it('parses the app_name with a trailing instruction', () => {
    expect(parseSpikeCommand('@ronin /spike backoffice mirá el flujo de checkout')).toEqual({
      appName: 'backoffice',
      instruction: 'mirá el flujo de checkout',
    });
  });

  it('trims surrounding whitespace off the instruction', () => {
    expect(parseSpikeCommand('/spike backoffice   revisá esto   ')).toEqual({
      appName: 'backoffice',
      instruction: 'revisá esto',
    });
  });

  it('returns null when there is no app_name at all', () => {
    expect(parseSpikeCommand('@ronin /spike')).toBeNull();
  });

  it('returns null when the command is absent', () => {
    expect(parseSpikeCommand('@ronin can you take a look?')).toBeNull();
  });
});

describe('findUnprocessedIssueMentions', () => {
  it('returns an issue comment that mentions the handle and has no reactions yet', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /spike backoffice', reactionsEyes: 0 },
    ]);

    const result = await findUnprocessedIssueMentions(500);
    expect(result).toEqual([{ id: 1, kind: 'issue', body: '@ronin /spike backoffice', reactionsEyes: 0 }]);
  });

  it('never calls listReviewComments — a plain issue has no inline review comments', async () => {
    issueComments.mockResolvedValue([]);

    await findUnprocessedIssueMentions(500);
    expect(reviewComments).not.toHaveBeenCalled();
  });

  it('excludes a mention already reacted to by the bot', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin /spike backoffice', reactionsEyes: 1 }]);
    botReaction.mockResolvedValue(true);

    const result = await findUnprocessedIssueMentions(500);
    expect(result).toEqual([]);
  });
});

describe('findTrustedSpikeCommand', () => {
  it('returns a /spike issue comment from any author with a real login', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /spike backoffice', reactionsEyes: 0, authorLogin: 'someone' },
    ]);

    const result = await findTrustedSpikeCommand(500);
    expect(result).toEqual([{ id: 1, kind: 'issue', body: '@ronin /spike backoffice', reactionsEyes: 0, authorLogin: 'someone' }]);
  });

  it('excludes a comment that does not carry the command', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin can you take a look?', reactionsEyes: 0, authorLogin: 'someone' },
    ]);

    const result = await findTrustedSpikeCommand(500);
    expect(result).toEqual([]);
  });

  it('excludes a comment with no author (deleted/ghost account)', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /spike backoffice', reactionsEyes: 0, authorLogin: '' },
    ]);

    const result = await findTrustedSpikeCommand(500);
    expect(result).toEqual([]);
  });
});
