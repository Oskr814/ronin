import { beforeEach, describe, expect, it, vi } from 'vitest';

const listTagRuns = vi.fn();
vi.mock('../../platform/github/github.js', () => ({ listTagRuns: (...args: unknown[]) => listTagRuns(...args) }));

const requests = new Map<number, Record<string, unknown>>();
vi.mock('../portal/requests.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../portal/requests.js')>()),
  updateRequest: async (n: number, fn: (r: Record<string, unknown>) => unknown) => fn(requests.get(n)!),
}));
const getUser = vi.fn();
vi.mock('../portal/accounts.js', () => ({ getUser: (...args: unknown[]) => getUser(...args) }));
const sendRequestsMail = vi.fn();
vi.mock('../portal/notify.js', () => ({ sendRequestsMail: (...args: unknown[]) => sendRequestsMail(...args) }));

import { rm } from 'node:fs/promises';
import { config } from '../../platform/config/config.js';
import { withActiveRepo } from '../../platform/agents/repo-context.js';
import type { WorkflowRun } from '../../platform/github/github.js';
import { deployState, followDeploys, NO_RUNS_AFTER_MS, RERUN_WINDOW_MS } from './follow.js';
import { addDeploy, listDeploys, type DeployRecord } from './store.js';

const run = (status: string, conclusion = '', sha = 'abc'): WorkflowRun => ({ databaseId: 1, workflowName: 'Deploy', status, conclusion, event: 'push', url: 'https://github.com/acme/app/actions/runs/1', headSha: sha });
const AT = '2026-10-18T12:00:00Z';
const record = (over: Partial<DeployRecord> = {}): DeployRecord => ({ repo: 'acme/app', tag: 'v1.0.1', prerelease: false, mode: 'pick', base: 'v1.0.0', sha: 'abc', url: '', changes: [{ pr: 3, subject: 'fix (#3)' }], pedidos: [7], by: 'persona', at: AT, state: 'running', ...over });
const follow = (now = Date.parse(AT) + 10 * 60_000) => withActiveRepo({ productRepo: 'acme/app', productRepoPath: '/nope' }, () => followDeploys(now));

beforeEach(async () => {
  vi.clearAllMocks();
  await rm(config.deploys.dataDir, { recursive: true, force: true });
  requests.clear();
  requests.set(7, { number: 7, userId: 'u1', title: 'El total más visible', events: [] });
  getUser.mockResolvedValue({ id: 'u1', name: 'Persona Ejemplo', email: 'persona@example.com' });
});

describe('deployState', () => {
  it('waits while a run goes or none showed up yet, and gives up on runs after a while', () => {
    expect(deployState([], 60_000)).toBe('running');
    expect(deployState([], NO_RUNS_AFTER_MS + 1)).toBe('unknown');
    expect(deployState([run('completed', 'success'), run('in_progress')], 0)).toBe('running');
    expect(deployState([run('completed', 'success'), run('completed', 'skipped')], 0)).toBe('deployed');
    expect(deployState([run('completed', 'success'), run('completed', 'failure')], 0)).toBe('failed');
  });
});

describe('followDeploys', () => {
  it('tells the requests of a deployed release, and their people', async () => {
    await addDeploy(record());
    listTagRuns.mockResolvedValue([run('completed', 'success'), run('completed', 'failure', 'otro-sha')]);
    await follow();
    expect(listTagRuns).toHaveBeenCalledWith('v1.0.1');
    expect((await listDeploys())[0]).toMatchObject({ state: 'deployed', runs: [{ name: 'Deploy', conclusion: 'success' }] });
    const request = requests.get(7)!;
    expect(request.events).toEqual([expect.objectContaining({ kind: 'deploy', tag: 'v1.0.1', state: 'deployed', prerelease: false })]);
    expect(request.deployed).toMatchObject({ tag: 'v1.0.1' });
    expect(sendRequestsMail).toHaveBeenCalledWith([request], expect.objectContaining({ to: 'persona@example.com', subject: 'Ya está en la aplicación: El total más visible' }));
  });

  it('mails each person once, with all of theirs the release carried', async () => {
    requests.set(8, { number: 8, userId: 'u1', title: 'Otro botón', events: [] });
    requests.set(9, { number: 9, userId: 'u2', title: 'Un reporte nuevo', events: [] });
    getUser.mockImplementation(async (id: string) => ({ id, name: `Persona ${id}`, email: `${id}@example.com` }));
    await addDeploy(record({ pedidos: [7, 8, 9] }));
    listTagRuns.mockResolvedValue([run('completed', 'success')]);
    await follow();
    expect(sendRequestsMail).toHaveBeenCalledTimes(2);
    expect(sendRequestsMail).toHaveBeenCalledWith([requests.get(7), requests.get(8)], expect.objectContaining({ to: 'u1@example.com', subject: 'Ya están en la aplicación: 2 de tus pedidos' }));
    expect(sendRequestsMail).toHaveBeenCalledWith([requests.get(9)], expect.objectContaining({ to: 'u2@example.com', subject: 'Ya está en la aplicación: Un reporte nuevo' }));
    for (const n of [7, 8, 9]) expect(requests.get(n)!.events).toEqual([expect.objectContaining({ kind: 'deploy', state: 'deployed' })]);
  });

  it('notes a pre-release on its requests without mailing anyone', async () => {
    await addDeploy(record({ prerelease: true }));
    listTagRuns.mockResolvedValue([run('completed', 'success')]);
    await follow();
    expect(requests.get(7)!.events).toEqual([expect.objectContaining({ state: 'deployed', prerelease: true })]);
    expect(requests.get(7)!.deployed).toBeUndefined();
    expect(sendRequestsMail).not.toHaveBeenCalled();
  });

  it('notes a failed one, and mails nobody', async () => {
    await addDeploy(record());
    listTagRuns.mockResolvedValue([run('completed', 'failure')]);
    await follow();
    expect((await listDeploys())[0].state).toBe('failed');
    expect(requests.get(7)!.events).toEqual([expect.objectContaining({ state: 'failed' })]);
    expect(sendRequestsMail).not.toHaveBeenCalled();
  });

  it('leaves a running one, and drops one no run showed up for', async () => {
    await addDeploy(record());
    await addDeploy(record({ tag: 'v1.0.2', at: '2026-10-18T08:00:00Z' }));
    listTagRuns.mockImplementation(async (tag: string) => (tag === 'v1.0.1' ? [run('in_progress')] : []));
    await follow();
    expect(Object.fromEntries((await listDeploys()).map((d) => [d.tag, d.state]))).toEqual({ 'v1.0.1': 'running', 'v1.0.2': 'unknown' });
    expect(requests.get(7)!.events).toEqual([]);
  });

  it('follows a failed one re-run on GitHub: going again, then deployed', async () => {
    await addDeploy(record({ state: 'failed', endedAt: AT, runs: [{ name: 'Deploy', conclusion: 'failure', url: '' }] }));
    listTagRuns.mockResolvedValue([run('completed', 'failure')]);
    await follow();
    expect((await listDeploys())[0].state).toBe('failed');
    expect(requests.get(7)!.events).toEqual([]);
    listTagRuns.mockResolvedValue([run('in_progress')]);
    await follow();
    const again = (await listDeploys())[0];
    expect(again.state).toBe('running');
    expect(again.endedAt).toBeUndefined();
    listTagRuns.mockResolvedValue([run('completed', 'success')]);
    await follow();
    expect((await listDeploys())[0]).toMatchObject({ state: 'deployed', runs: [{ conclusion: 'success' }] });
    expect(requests.get(7)!.events).toEqual([expect.objectContaining({ state: 'deployed' })]);
    expect(sendRequestsMail).toHaveBeenCalledTimes(1);
  });

  it('stops looking at a failed one once GitHub no longer re-runs it', async () => {
    await addDeploy(record({ state: 'failed', endedAt: AT }));
    await follow(Date.parse(AT) + RERUN_WINDOW_MS + 1);
    expect(listTagRuns).not.toHaveBeenCalled();
  });

  it('only follows the active repo', async () => {
    await addDeploy(record({ repo: 'otro/repo' }));
    await follow();
    expect(listTagRuns).not.toHaveBeenCalled();
  });
});
