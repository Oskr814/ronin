import { describe, expect, it } from 'vitest';
import type { LinearIssue } from '../../core/linear-api.js';
import type { RepoGithub } from './dashboard-github.js';
import { cycleView, type RepoLinear } from './dashboard-linear.js';

const issue = (id: string, number: number | undefined, type: LinearIssue['state']['type'], extra: Partial<LinearIssue> = {}): LinearIssue => ({
  id, title: id, url: `https://linear.app/red-motos/issue/${id}`, state: { name: type, type }, ...(number !== undefined ? { githubNumber: number } : {}), ...extra,
});

const GH = {
  repo: 'acme/product', fetchedAt: '', previews: [], blocks: {},
  issues: [
    { number: 10, title: '', url: '', status: 'in-progress' as const, direct: true, slices: [{ index: 0, title: 's', checked: false, prNumber: 50 }] },
    { number: 11, title: '', url: '', status: 'in-progress' as const, direct: true, slices: [{ index: 0, title: 's', checked: false, prNumber: null }] },
    { number: 12, title: '', url: '', status: 'blocked' as const, direct: true, slices: [] },
    { number: 13, title: '', url: '', status: 'other' as const, direct: false, slices: [] },
  ],
  prs: [{ number: 50 }],
} as unknown as RepoGithub;

const LINEAR: RepoLinear = {
  repo: 'acme/product', workspace: 'red-motos', fetchedAt: '', issues: {},
  cycle: {
    team: 'RED', number: 17, startsAt: '2026-10-12', endsAt: '2026-10-19', scopeHistory: [3, 7], doneHistory: [1, 2],
    issues: [
      issue('RED-1', 10, 'started'),
      issue('RED-2', 11, 'started'),
      issue('RED-3', 12, 'started'),
      issue('RED-4', 13, 'started', { state: { name: 'In Review', type: 'started' }, assignee: 'abdias' }),
      issue('RED-5', undefined, 'started', { assignee: 'oskr' }),
      issue('RED-6', 20, 'backlog', { project: { id: 'p', name: 'Catálogos' } }),
      issue('RED-7', 10, 'completed'),
    ],
  },
};

describe('cycleView', () => {
  it("places ronin's issues by GitHub and the team's by their Linear state", () => {
    const view = cycleView(LINEAR, GH)!;
    expect(view.issues.map((i) => [i.id, i.bucket, i.owner])).toEqual([
      ['RED-1', 'review', 'ronin'],
      ['RED-2', 'ronin', 'ronin'],
      ['RED-3', 'blocked', 'ronin'],
      ['RED-4', 'review', 'abdias'],
      ['RED-5', 'started', 'oskr'],
      ['RED-6', 'todo', ''],
      ['RED-7', 'done', 'ronin'],
    ]);
    expect(view).toMatchObject({ repo: 'acme/product', workspace: 'red-motos', team: 'RED', number: 17, scopeHistory: [3, 7], doneHistory: [1, 2] });
    expect(view.issues[5]).toMatchObject({ number: 20, project: { name: 'Catálogos' } });
  });

  it('is null without a current cycle', () => {
    expect(cycleView({ ...LINEAR, cycle: null }, GH)).toBeNull();
  });
});
