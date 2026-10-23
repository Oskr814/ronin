import { describe, it, expect, vi, beforeEach } from 'vitest';

const listOpenUnmanagedIssues = vi.fn();
vi.mock('@platform/github/github.js', () => ({
  listOpenUnmanagedIssues: (...args: unknown[]) => listOpenUnmanagedIssues(...args),
}));

const findTrustedSpikeCommand = vi.fn();
const findTrustedExploreCommand = vi.fn();
const parseSpikeCommand = vi.fn();
vi.mock('./mentions.js', () => ({
  // One read per issue now returns both commands; the tests drive each half.
  findTrustedIssueCommands: async (...args: unknown[]) => ({
    spike: await findTrustedSpikeCommand(...args),
    explore: await findTrustedExploreCommand(...args),
    spec: [],
  }),
  parseSpikeCommand: (...args: unknown[]) => parseSpikeCommand(...args),
  parseSpecCommand: () => null,
  parseExploreCommand: (body: string) => {
    const match = body.match(/\/explore\s+(\S+)(?:\s+(\d+))?/);
    return match ? { appName: match[1], ...(match[2] ? { maxFunctions: Number(match[2]) } : {}) } : null;
  },
}));

import { findIssueCommands, findIssuesNeedingSpike } from './spike.js';

function issue(overrides: Partial<{ number: number; title: string; updatedAt: string }> = {}) {
  return { number: 500, title: 'Login redirects to 404', updatedAt: new Date().toISOString(), ...overrides };
}

function comment(overrides: Partial<{ id: number; kind: 'issue' | 'review'; body: string; reactionsEyes: number; authorLogin: string }> = {}) {
  return { id: 1, kind: 'issue' as const, body: '@ronin /spike backoffice', reactionsEyes: 0, authorLogin: 'someone', ...overrides };
}

beforeEach(() => {
  listOpenUnmanagedIssues.mockReset().mockResolvedValue([]);
  findTrustedSpikeCommand.mockReset().mockResolvedValue([]);
  findTrustedExploreCommand.mockReset().mockResolvedValue([]);
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

});

// gh listed only 30 open issues, so a command on any past those was never
// seen. Now all of them are listed, and only the ones updated lately have
// their comments read.
describe('findIssueCommands — which issues it reads', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  it('reads the comments of the issues updated in the last days, not of the ones nobody touched', async () => {
    listOpenUnmanagedIssues.mockResolvedValue([issue({ number: 500, updatedAt: daysAgo(1) }), issue({ number: 501, updatedAt: daysAgo(10) })]);
    findTrustedSpikeCommand.mockResolvedValue([comment()]);

    const { spikes } = await findIssueCommands();

    expect(spikes.map((s) => s.issueNumber)).toEqual([500]);
    expect(findTrustedSpikeCommand).toHaveBeenCalledTimes(1);
  });

  it('reads the issues an event names, however long ago they were updated', async () => {
    listOpenUnmanagedIssues.mockResolvedValue([issue({ number: 500, updatedAt: daysAgo(10) }), issue({ number: 501, updatedAt: daysAgo(10) })]);
    findTrustedSpikeCommand.mockResolvedValue([comment()]);

    const { spikes } = await findIssueCommands([501]);

    expect(spikes.map((s) => s.issueNumber)).toEqual([501]);
  });
});
