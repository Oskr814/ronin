import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: { githubLogin: 'ronin' },
}));

const issueComments = vi.fn();
const reviewComments = vi.fn();
const botReaction = vi.fn();
const replyToComment = vi.fn();
const addReaction = vi.fn();

vi.mock('./github.js', () => ({
  listIssueComments: (...args: unknown[]) => issueComments(...args),
  listReviewComments: (...args: unknown[]) => reviewComments(...args),
  hasBotReaction: (...args: unknown[]) => botReaction(...args),
  replyToComment: (...args: unknown[]) => replyToComment(...args),
  addReaction: (...args: unknown[]) => addReaction(...args),
}));

vi.mock('./logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

const launchPreviewWorker = vi.fn();
vi.mock('./preview.js', () => ({ launchPreviewWorker: (...args: unknown[]) => launchPreviewWorker(...args) }));
const applyAutoMergeCommand = vi.fn();
vi.mock('./auto-merge.js', () => ({ applyAutoMergeCommand: (...args: unknown[]) => applyAutoMergeCommand(...args) }));
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'acme/product' }) }));
const launchConflictsWorker = vi.fn();
vi.mock('./conflicts.js', () => ({ launchConflictsWorker: (...args: unknown[]) => launchConflictsWorker(...args) }));

import {
  parseAutoMergeCommand,
  parsePreviewCommand,
  isResolveConflictsCommand,
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
  replyToComment.mockReset().mockResolvedValue(undefined);
  addReaction.mockReset().mockResolvedValue(undefined);
  launchPreviewWorker.mockReset();
  launchConflictsWorker.mockReset();
  applyAutoMergeCommand.mockReset().mockResolvedValue(undefined);
});

describe('parsePreviewCommand', () => {
  it('keeps everything after the command, other lines included, as its arguments', () => {
    expect(parsePreviewCommand('@ronin /preview', 'ronin')).toEqual({ action: 'up' });
    expect(parsePreviewCommand('@ronin /preview backoffice', 'ronin')).toEqual({ action: 'up', args: 'backoffice' });
    expect(parsePreviewCommand('@Ronin /PREVIEW backoffice\nun cliente con 40 catálogos', 'ronin'))
      .toEqual({ action: 'up', args: 'backoffice\nun cliente con 40 catálogos' });
  });

  it('reads stop and its synonyms, only on their own', () => {
    expect(parsePreviewCommand('@ronin /preview stop', 'ronin')).toEqual({ action: 'stop' });
    expect(parsePreviewCommand('@ronin /preview OFF ', 'ronin')).toEqual({ action: 'stop' });
    expect(parsePreviewCommand('@ronin /preview down to 3 clientes', 'ronin')).toEqual({ action: 'up', args: 'down to 3 clientes' });
  });

  it('reads /preview-stop and its hyphenated synonyms as stop', () => {
    expect(parsePreviewCommand('@ronin /preview-stop', 'ronin')).toEqual({ action: 'stop' });
    expect(parsePreviewCommand('@ronin /Preview-Off gracias', 'ronin')).toEqual({ action: 'stop' });
    expect(parsePreviewCommand('@ronin /preview-stopped', 'ronin')).toBeNull();
    expect(parsePreviewCommand('@ronin /preview-foo', 'ronin')).toBeNull();
  });

  it('only counts right after the mention, never inside a plain request', () => {
    expect(parsePreviewCommand('@ronin revisá src/preview/card.tsx', 'ronin')).toBeNull();
    expect(parsePreviewCommand('@ronin /preview/card.tsx', 'ronin')).toBeNull();
    expect(parsePreviewCommand('@ronin /previews', 'ronin')).toBeNull();
    expect(parsePreviewCommand('/preview backoffice', 'ronin')).toBeNull();
  });
});

describe('findUnprocessedMentions with /preview', () => {
  it('launches the preview worker, reacts, and keeps the command away from the other flows', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /preview backoffice', reactionsEyes: 0, authorLogin: 'ana' },
      { id: 2, kind: 'issue', body: '@ronin revisá esto', reactionsEyes: 0, authorLogin: 'ana' },
    ]);

    const result = await findUnprocessedMentions(42);
    expect(result.map((c) => c.id)).toEqual([2]);
    expect(launchPreviewWorker).toHaveBeenCalledWith({
      repo: 'acme/product', prNumber: 42, action: 'up', args: 'backoffice', comment: { id: 1, kind: 'issue' },
    });
    expect(addReaction).toHaveBeenCalledWith(1, 'issue', 'eyes');
  });

  it('answers in the thread when /preview came in a review comment', async () => {
    reviewComments.mockResolvedValue([{ id: 7, kind: 'review', body: '@ronin /preview stop', reactionsEyes: 0, authorLogin: 'ana' }]);

    await findUnprocessedMentions(42);
    expect(launchPreviewWorker).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop', comment: { id: 7, kind: 'review' } }));
  });

  it('does not react when the worker could not be launched, so the next tick retries', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin /preview', reactionsEyes: 0, authorLogin: 'ana' }]);
    launchPreviewWorker.mockImplementation(() => { throw new Error('spawn failed'); });

    expect(await findUnprocessedMentions(42)).toEqual([]);
    expect(addReaction).not.toHaveBeenCalled();
  });
});

describe('isResolveConflictsCommand', () => {
  it('reads the command and its aliases right after the mention', () => {
    expect(isResolveConflictsCommand('@ronin /resolve-conflicts', 'ronin')).toBe(true);
    expect(isResolveConflictsCommand('@Ronin /Resolve-Conflict por favor', 'ronin')).toBe(true);
    expect(isResolveConflictsCommand('@ronin /fix-conflicts', 'ronin')).toBe(true);
    expect(isResolveConflictsCommand('@ronin /conflicts', 'ronin')).toBe(true);
  });

  it('ignores it anywhere else, and paths that only start like it', () => {
    expect(isResolveConflictsCommand('/resolve-conflicts', 'ronin')).toBe(false);
    expect(isResolveConflictsCommand('@ronin mirá /conflicts', 'ronin')).toBe(false);
    expect(isResolveConflictsCommand('@ronin /conflicts/merge.ts', 'ronin')).toBe(false);
    expect(isResolveConflictsCommand('@ronin /conflicts.ts', 'ronin')).toBe(false);
    expect(isResolveConflictsCommand('@ronin /fix-comments', 'ronin')).toBe(false);
  });
});

describe('findUnprocessedMentions with /resolve-conflicts', () => {
  it('launches the conflicts worker, reacts, and keeps the command away from the other flows', async () => {
    reviewComments.mockResolvedValue([
      { id: 3, kind: 'review', body: '@ronin /resolve-conflicts', reactionsEyes: 0, authorLogin: 'ana' },
      { id: 4, kind: 'review', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'ana' },
    ]);

    const result = await findUnprocessedMentions(42);
    expect(result.map((c) => c.id)).toEqual([4]);
    expect(launchConflictsWorker).toHaveBeenCalledWith({ repo: 'acme/product', prNumber: 42, comment: { id: 3, kind: 'review' } });
    expect(addReaction).toHaveBeenCalledWith(3, 'review', 'eyes');
  });

  it('does not react when the worker could not be launched, so the next tick retries', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin /resolve-conflicts', reactionsEyes: 0, authorLogin: 'ana' }]);
    launchConflictsWorker.mockImplementation(() => { throw new Error('spawn failed'); });

    expect(await findUnprocessedMentions(42)).toEqual([]);
    expect(addReaction).not.toHaveBeenCalled();
  });
});

describe('parseAutoMergeCommand', () => {
  it('reads it on and off, in its usual spellings', () => {
    expect(parseAutoMergeCommand('@ronin /auto-merge', 'ronin')).toBe('on');
    expect(parseAutoMergeCommand('@Ronin /AutoMerge cuando esté', 'ronin')).toBe('on');
    expect(parseAutoMergeCommand('@ronin /auto-merge off', 'ronin')).toBe('off');
    expect(parseAutoMergeCommand('@ronin /auto-merge Cancel por ahora', 'ronin')).toBe('off');
    expect(parseAutoMergeCommand('@ronin /auto-merge-stop', 'ronin')).toBe('off');
    expect(parseAutoMergeCommand('@ronin /automerge-off', 'ronin')).toBe('off');
    expect(parseAutoMergeCommand('@ronin /auto-merge.', 'ronin')).toBe('on');
    expect(parseAutoMergeCommand('@ronin /auto-merge off.', 'ronin')).toBe('off');
  });

  it('is only the command right after the mention', () => {
    expect(parseAutoMergeCommand('@ronin revisá src/auto-merge.ts', 'ronin')).toBeNull();
    expect(parseAutoMergeCommand('@ronin /auto-merge.ts', 'ronin')).toBeNull();
    expect(parseAutoMergeCommand('@ronin /auto-merged', 'ronin')).toBeNull();
    expect(parseAutoMergeCommand('/auto-merge', 'ronin')).toBeNull();
  });
});

describe('findUnprocessedMentions with /auto-merge', () => {
  it('applies it and keeps it away from the other flows', async () => {
    reviewComments.mockResolvedValue([{ id: 7, kind: 'review', body: '@ronin /auto-merge off', reactionsEyes: 0, authorLogin: 'ana' }]);
    issueComments.mockResolvedValue([{ id: 2, kind: 'issue', body: '@ronin revisá esto', reactionsEyes: 0, authorLogin: 'ana' }]);

    const result = await findUnprocessedMentions(42);
    expect(result.map((c) => c.id)).toEqual([2]);
    expect(applyAutoMergeCommand).toHaveBeenCalledWith(42, expect.objectContaining({ id: 7, kind: 'review' }), 'off');
  });

  it('drops it even when applying failed (no 👀, retried next tick)', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin /auto-merge', reactionsEyes: 0, authorLogin: 'ana' }]);
    applyAutoMergeCommand.mockRejectedValue(new Error('gh down'));

    expect(await findUnprocessedMentions(42)).toEqual([]);
  });
});

describe('meta-commands (/help, typos, wrong place)', () => {
  it('answers /help on a PR without handing it to any flow, and marks it processed', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin /help', reactionsEyes: 0, authorLogin: 'someone' }]);

    const result = await findUnprocessedMentions(42);

    expect(result).toEqual([]);
    expect(replyToComment).toHaveBeenCalledWith(42, expect.objectContaining({ id: 1 }), expect.stringContaining('/fix-comments'));
    expect(addReaction).toHaveBeenCalledWith(1, 'issue', 'eyes');
  });

  it('suggests the closest command for a typo, replying inside an inline thread', async () => {
    reviewComments.mockResolvedValue([{ id: 5, kind: 'review', body: '@ronin /fix-coments', reactionsEyes: 0, authorLogin: 'someone' }]);

    const result = await findUnprocessedMentions(42);

    expect(result).toEqual([]);
    expect(replyToComment).toHaveBeenCalledWith(42, expect.objectContaining({ id: 5, kind: 'review' }), expect.stringContaining('¿Quisiste decir `/fix-comments`?'));
  });

  it('treats /spike on a PR as a command in the wrong place', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin /spike backoffice', reactionsEyes: 0, authorLogin: 'someone' }]);

    const result = await findUnprocessedMentions(42);

    expect(result).toEqual([]);
    expect(replyToComment).toHaveBeenCalledWith(42, expect.anything(), expect.stringContaining('`/spike` solo funciona en issues'));
  });

  it('treats /fix-comments on a plain issue as a command in the wrong place', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' }]);

    const result = await findUnprocessedIssueMentions(7);

    expect(result).toEqual([]);
    expect(replyToComment).toHaveBeenCalledWith(7, expect.anything(), expect.stringContaining('`/fix-comments` solo funciona en PRs'));
  });

  it('lets a real command and free text through untouched', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' },
      { id: 2, kind: 'issue', body: '@ronin revisá /src/foo.ts por favor', reactionsEyes: 0, authorLogin: 'someone' },
    ]);

    const result = await findUnprocessedMentions(42);

    expect(result.map((c) => c.id)).toEqual([1, 2]);
    expect(replyToComment).not.toHaveBeenCalled();
  });

  it('drops a meta-command even when the reply fails, without marking it processed', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin /help', reactionsEyes: 0, authorLogin: 'someone' }]);
    replyToComment.mockRejectedValue(new Error('gh exploded'));

    const result = await findUnprocessedMentions(42);

    expect(result).toEqual([]);
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("ignores ronin's own comments, even when they mention it", async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: 'Podés usar `@ronin /fix-comments`', reactionsEyes: 0, authorLogin: 'Ronin' },
    ]);

    const result = await findUnprocessedMentions(42);

    expect(result).toEqual([]);
    expect(replyToComment).not.toHaveBeenCalled();
  });
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

describe('parseExploreCommand', () => {
  it('reads the app and an optional function count, capped at 10', async () => {
    const { parseExploreCommand, isExploreCommand } = await import('./mentions.js');
    expect(parseExploreCommand('@ronin /explore backoffice')).toEqual({ appName: 'backoffice' });
    expect(parseExploreCommand('@ronin /explore backoffice 2')).toEqual({ appName: 'backoffice', maxFunctions: 2 });
    expect(parseExploreCommand('@ronin /explore backoffice 50')).toEqual({ appName: 'backoffice', maxFunctions: 10 });
    expect(parseExploreCommand('@ronin /explore')).toBeNull();
    expect(isExploreCommand('@ronin /explore backoffice')).toBe(true);
    expect(isExploreCommand('@ronin /explorer')).toBe(false);
  });
});

describe('parseSpecCommand', () => {
  it('reads the app and an optional instruction, and is told apart from other commands', async () => {
    const { parseSpecCommand, isSpecCommand } = await import('./mentions.js');
    expect(parseSpecCommand('@ronin /spec backoffice')).toEqual({ appName: 'backoffice', instruction: undefined });
    expect(parseSpecCommand('@ronin /spec backoffice que bodega pueda escanear')).toEqual({ appName: 'backoffice', instruction: 'que bodega pueda escanear' });
    expect(parseSpecCommand('@ronin /spec')).toBeNull();
    expect(isSpecCommand('@ronin /specs')).toBe(false);
  });
});

describe('parsePrototypeCommand', () => {
  it('reads the app and an optional instruction', async () => {
    const { parsePrototypeCommand, isPrototypeCommand } = await import('./mentions.js');
    expect(parsePrototypeCommand('@ronin /prototype backoffice')).toEqual({ appName: 'backoffice', instruction: undefined });
    expect(parsePrototypeCommand('@ronin /prototype backoffice el modal\ncon la lista')).toEqual({ appName: 'backoffice', instruction: 'el modal\ncon la lista' });
    expect(parsePrototypeCommand('@ronin /prototype')).toBeNull();
    expect(isPrototypeCommand('@ronin /prototypes')).toBe(false);
  });
});

describe('findTrustedIssueCommands', () => {
  const c = (id: number, body: string, authorLogin = 'someone') => ({ id, kind: 'issue' as const, body, reactionsEyes: 0, authorLogin });

  it('puts each mention in exactly one bucket, and a mention with no command in request', async () => {
    const { findTrustedIssueCommands } = await import('./mentions.js');
    issueComments.mockResolvedValue([
      c(1, '@ronin /spike backoffice'),
      c(2, '@ronin /explore backoffice'),
      c(3, '@ronin /spec backoffice'),
      c(4, '@ronin /prototype backoffice el modal'),
      c(5, '@ronin esto aplica sobre otras vistas, propongo definir este estándar'),
      c(6, 'sin mención, no cuenta'),
    ]);

    const commands = await findTrustedIssueCommands(500);

    expect(commands.spike.map((m) => m.id)).toEqual([1]);
    expect(commands.explore.map((m) => m.id)).toEqual([2]);
    expect(commands.spec.map((m) => m.id)).toEqual([3]);
    expect(commands.prototype.map((m) => m.id)).toEqual([4]);
    expect(commands.request.map((m) => m.id)).toEqual([5]);
  });

  it('leaves a request without a real author out, like every other command', async () => {
    const { findTrustedIssueCommands } = await import('./mentions.js');
    issueComments.mockResolvedValue([c(5, '@ronin cambiá el alcance', '')]);

    expect((await findTrustedIssueCommands(500)).request).toEqual([]);
  });
});
