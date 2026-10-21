import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinearPending } from '../state/local-state.js';

let state: { linearPending: LinearPending[] };
vi.mock('../state/local-state.js', () => ({
  readLocalState: async () => structuredClone(state),
  writeLocalState: async (next: typeof state) => { state = structuredClone(next); },
  withLocalStateLock: <T>(fn: () => Promise<T>) => fn(),
}));
const entry = { productRepo: 'redmotos/shoppingcart', productRepoPath: '/x', linear: { apiKeyEnv: 'K', explorationProject: { backoffice: 'Mejoras de backoffice' } } };
vi.mock('../agents/repo-context.js', () => ({ activeRepo: () => entry }));
vi.mock('../logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const linearKey = vi.fn(() => 'lin_key');
const linearIssuesFor = vi.fn();
const resolveProject = vi.fn();
const updateIssue = vi.fn();
vi.mock('./linear-api.js', () => ({
  linearKey: () => linearKey(),
  linearIssuesFor: (...a: unknown[]) => linearIssuesFor(...a),
  resolveProject: (...a: unknown[]) => resolveProject(...a),
  updateIssue: (...a: unknown[]) => updateIssue(...a),
}));

const { processLinearAssignments, queueExplorationProject, queueLinearAssignment } = await import('./linear-assign.js');

const linear = (number: number, extra: Record<string, unknown> = {}) => [number, { id: `RED-${number}`, uuid: `u-${number}`, title: '', url: '', state: { name: 'Todo', type: 'unstarted' }, githubNumber: number, ...extra }] as const;

beforeEach(() => {
  state = { linearPending: [] };
  linearKey.mockReturnValue('lin_key');
  linearIssuesFor.mockReset().mockResolvedValue(new Map());
  resolveProject.mockReset().mockResolvedValue('p-expl');
  updateIssue.mockReset().mockResolvedValue(undefined);
});

describe('queueLinearAssignment', () => {
  it('queues only with a Linear key and something to set', async () => {
    await queueLinearAssignment({ number: 1 });
    expect(state.linearPending).toEqual([]);
    linearKey.mockReturnValue(null as unknown as string);
    await queueLinearAssignment({ number: 2, projectId: 'p' });
    expect(state.linearPending).toEqual([]);
    linearKey.mockReturnValue('lin_key');
    await queueExplorationProject('backoffice', 3);
    await queueExplorationProject('webapp', 4);
    expect(state.linearPending).toEqual([expect.objectContaining({ number: 3, projectName: 'Mejoras de backoffice' })]);
  });
});

describe('processLinearAssignments', () => {
  it('waits while the sync has not created the issue, and gives up after a day', async () => {
    const since = new Date().toISOString();
    state.linearPending = [{ number: 10, projectId: 'p', since }, { number: 11, projectId: 'p', since: new Date(Date.now() - 25 * 3600_000).toISOString() }];
    await processLinearAssignments();
    expect(state.linearPending.map((p) => p.number)).toEqual([10]);
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('applies a dashboard choice as made, project and cycle', async () => {
    state.linearPending = [{ number: 10, projectId: 'p1', cycleId: 'c1', since: new Date().toISOString() }];
    linearIssuesFor.mockResolvedValue(new Map([linear(10, { project: { id: 'otro', name: 'Otro' } })]));
    await processLinearAssignments();
    expect(updateIssue).toHaveBeenCalledWith('lin_key', 'u-10', { projectId: 'p1', cycleId: 'c1' });
    expect(state.linearPending).toEqual([]);
  });

  it("puts an exploration issue in the app's project, unless it already has one", async () => {
    state.linearPending = [{ number: 20, projectName: 'Mejoras de backoffice', since: new Date().toISOString() }, { number: 21, projectName: 'Mejoras de backoffice', since: new Date().toISOString() }];
    linearIssuesFor.mockResolvedValue(new Map([linear(20), linear(21, { project: { id: 'ya', name: 'Ya' } })]));
    await processLinearAssignments();
    expect(resolveProject).toHaveBeenCalledWith('lin_key', 'Mejoras de backoffice');
    expect(updateIssue).toHaveBeenCalledTimes(1);
    expect(updateIssue).toHaveBeenCalledWith('lin_key', 'u-20', { projectId: 'p-expl' });
    expect(state.linearPending).toEqual([]);
  });

  it('gives a spec issue the project of the issue it came from', async () => {
    state.linearPending = [{ number: 30, fromIssue: 25, since: new Date().toISOString() }];
    linearIssuesFor.mockResolvedValue(new Map([linear(30), linear(25, { project: { id: 'p-origen', name: 'Origen' } })]));
    await processLinearAssignments();
    expect(linearIssuesFor).toHaveBeenCalledWith(entry, 'lin_key', [30, 25]);
    expect(updateIssue).toHaveBeenCalledWith('lin_key', 'u-30', { projectId: 'p-origen' });
  });

  it('retries a failure a few times, then stops', async () => {
    state.linearPending = [{ number: 40, projectId: 'p', since: new Date().toISOString(), attempts: 3 }];
    linearIssuesFor.mockResolvedValue(new Map([linear(40)]));
    updateIssue.mockRejectedValue(new Error('Linear respondió 500'));
    await processLinearAssignments();
    expect(state.linearPending).toEqual([expect.objectContaining({ number: 40, attempts: 4 })]);
    await processLinearAssignments();
    expect(state.linearPending).toEqual([]);
  });
});
