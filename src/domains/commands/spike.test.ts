import { describe, it, expect, vi, beforeEach } from 'vitest';

const listOpenUnmanagedIssues = vi.fn();
vi.mock('@platform/github/github.js', () => ({
  listOpenUnmanagedIssues: (...args: unknown[]) => listOpenUnmanagedIssues(...args),
}));

const findTrustedSpikeCommand = vi.fn();
const findTrustedExploreCommand = vi.fn();
const findTrustedPrototypeCommand = vi.fn();
const parseSpikeCommand = vi.fn();
vi.mock('./mentions.js', () => ({
  // One read per issue now returns both commands; the tests drive each half.
  findTrustedIssueCommands: async (...args: unknown[]) => ({
    spike: await findTrustedSpikeCommand(...args),
    explore: await findTrustedExploreCommand(...args),
    spec: [],
    prototype: await findTrustedPrototypeCommand(...args),
  }),
  parsePrototypeCommand: (body: string) => {
    const match = body.match(/\/prototype\s+(\S+)(?:\s+([\s\S]+))?/);
    return match ? { appName: match[1], instruction: match[2]?.trim() || undefined } : null;
  },
  parseSpikeCommand: (...args: unknown[]) => parseSpikeCommand(...args),
  parseSpecCommand: () => null,
  parseExploreCommand: (body: string) => {
    const match = body.match(/\/explore\s+(\S+)(?:\s+(\d+))?/);
    return match ? { appName: match[1], ...(match[2] ? { maxFunctions: Number(match[2]) } : {}) } : null;
  },
}));

import { findIssueCommands, findIssuesNeedingSpike } from './spike.js';

function issue(overrides: Partial<{ number: number; title: string }> = {}) {
  return { number: 500, title: 'Login redirects to 404', ...overrides };
}

function comment(overrides: Partial<{ id: number; kind: 'issue' | 'review'; body: string; reactionsEyes: number; authorLogin: string }> = {}) {
  return { id: 1, kind: 'issue' as const, body: '@ronin /spike backoffice', reactionsEyes: 0, authorLogin: 'someone', ...overrides };
}

beforeEach(() => {
  listOpenUnmanagedIssues.mockReset().mockResolvedValue([]);
  findTrustedSpikeCommand.mockReset().mockResolvedValue([]);
  findTrustedExploreCommand.mockReset().mockResolvedValue([]);
  findTrustedPrototypeCommand.mockReset().mockResolvedValue([]);
  parseSpikeCommand.mockReset().mockReturnValue({ appName: 'backoffice', instruction: undefined });
});

describe('findIssuesNeedingSpike', () => {
  it('returns a candidate for an issue with a valid trusted /spike command', async () => {
    listOpenUnmanagedIssues.mockResolvedValue([issue()]);
    findTrustedSpikeCommand.mockResolvedValue([comment()]);
    parseSpikeCommand.mockReturnValue({ appName: 'backoffice', instruction: 'revisá el flujo de checkout' });

    const result = await findIssuesNeedingSpike();

    expect(result).toEqual([
      { issueNumber: 500, appName: 'backoffice', instruction: 'revisá el flujo de checkout', trigger: [comment()] },
    ]);
  });

  it('skips an issue with no /spike command at all', async () => {
    listOpenUnmanagedIssues.mockResolvedValue([issue()]);
    findTrustedSpikeCommand.mockResolvedValue([]);

    const result = await findIssuesNeedingSpike();

    expect(result).toEqual([]);
  });

  it('skips a malformed command missing app_name', async () => {
    listOpenUnmanagedIssues.mockResolvedValue([issue()]);
    findTrustedSpikeCommand.mockResolvedValue([comment({ body: '@ronin /spike' })]);
    parseSpikeCommand.mockReturnValue(null);

    const result = await findIssuesNeedingSpike();

    expect(result).toEqual([]);
  });

  it('never sees an already ronin-managed issue — listOpenUnmanagedIssues already excludes it', async () => {
    listOpenUnmanagedIssues.mockResolvedValue([]);

    const result = await findIssuesNeedingSpike();

    expect(result).toEqual([]);
    expect(findTrustedSpikeCommand).not.toHaveBeenCalled();
  });

  it('isolates a failure on one issue from the rest', async () => {
    listOpenUnmanagedIssues.mockResolvedValue([issue({ number: 500 }), issue({ number: 501, title: 'Other issue' })]);
    findTrustedSpikeCommand
      .mockRejectedValueOnce(new Error('gh: HTTP 500'))
      .mockResolvedValueOnce([comment()]);

    const result = await findIssuesNeedingSpike();

    expect(result).toEqual([
      { issueNumber: 501, appName: 'backoffice', instruction: undefined, trigger: [comment()] },
    ]);
  });
});

describe('findIssueCommands', () => {
  it('finds /explore with its app and optional function count, next to /spike', async () => {
    listOpenUnmanagedIssues.mockResolvedValue([issue({ number: 500 }), issue({ number: 501 })]);
    findTrustedSpikeCommand.mockResolvedValueOnce([comment()]).mockResolvedValueOnce([]);
    findTrustedExploreCommand.mockResolvedValueOnce([]).mockResolvedValueOnce([comment({ id: 9, body: '@ronin /explore backoffice 2' })]);

    const { spikes, explores } = await findIssueCommands();

    expect(spikes.map((s) => s.issueNumber)).toEqual([500]);
    expect(explores).toEqual([{ issueNumber: 501, appName: 'backoffice', maxFunctions: 2, trigger: [comment({ id: 9, body: '@ronin /explore backoffice 2' })] }]);
  });

  it('finds /prototype with its app and instruction', async () => {
    listOpenUnmanagedIssues.mockResolvedValue([issue()]);
    const trigger = comment({ id: 7, body: '@ronin /prototype backoffice el modal con la lista de productos' });
    findTrustedPrototypeCommand.mockResolvedValue([trigger]);

    const { prototypes } = await findIssueCommands();

    expect(prototypes).toEqual([{ issueNumber: 500, appName: 'backoffice', instruction: 'el modal con la lista de productos', trigger: [trigger] }]);
  });

  it('skips a /prototype missing its app', async () => {
    listOpenUnmanagedIssues.mockResolvedValue([issue()]);
    findTrustedPrototypeCommand.mockResolvedValue([comment({ body: '@ronin /prototype' })]);

    expect((await findIssueCommands()).prototypes).toEqual([]);
  });
});
