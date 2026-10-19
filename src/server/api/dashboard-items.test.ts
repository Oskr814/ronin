import { describe, it, expect } from 'vitest';
import type { OpenPr } from '../../core/github.js';
import type { RunSummary } from './dashboard-data.js';
import type { RepoGithub } from './dashboard-github.js';
import { buildItems, itemRunKeys, prNote } from './dashboard-items.js';

const REPO = 'acme/product';

function run(fields: Partial<RunSummary>): RunSummary {
  return { runId: 'r', repo: REPO, taskType: 'implement-slice', label: 'x', account: 'a', worktree: '/w', startedAt: '2026-10-16T10:00:00Z', state: 'ok', steps: 1, ...fields };
}

function pr(fields: Partial<OpenPr>): OpenPr {
  return { number: 1, title: 'PR', url: 'u', author: 'ronin-agent', isDraft: false, headRefName: 'ronin/1/slice-1', baseRefName: 'main', reviewDecision: '', checks: [], ...fields };
}

function github(fields: Partial<RepoGithub>): RepoGithub {
  return { repo: REPO, fetchedAt: '2026-10-16T10:00:00Z', issues: [], openIssues: [], prs: [], prIssue: {}, previews: [], blocks: {}, ...fields };
}

const ISSUE_879 = {
  number: 879, title: 'Validar stock y reservar', url: 'https://github.com/acme/product/issues/879', status: 'in-progress' as const, direct: false,
  slices: [
    { index: 0, title: 'Reserva en el modelo', checked: true, prNumber: 881 },
    { index: 1, title: 'Validar al confirmar', checked: false, prNumber: 894 },
    { index: 2, title: 'Liberar vencidas', checked: false, prNumber: null },
  ],
};

describe('buildItems — issues only (#100)', () => {
  const OPEN = [{ number: 405, title: 'Exportar a Excel', url: 'u405', labels: [] }, { number: 406, title: 'Otro', url: 'u406', labels: [] }];

  it("lists every open issue, but only ronin's and the ones it worked on without searching", () => {
    const items = buildItems([REPO], [], [github({ issues: [ISSUE_879], openIssues: [{ number: 879, title: 'Validar stock y reservar', url: 'u', labels: ['ronin'] }, ...OPEN] })]);
    expect(items.map((i) => [i.id, i.listed, i.status])).toEqual([
      ['acme/product#879', true, 'waiting'],
      ['acme/product#405', false, 'open'],
      ['acme/product#406', false, 'open'],
    ]);
  });

  it("puts a person's PR inside its issue, and a run on it makes the issue listed", () => {
    const items = buildItems([REPO], [run({ runId: 'rv', taskType: 'external-review', prNumber: 920, startedAt: '2026-10-16T12:00:00Z' })], [github({
      openIssues: OPEN,
      prs: [pr({ number: 920, author: 'valeria', headRefName: 'feat/405-excel', checks: [{ name: 'ci', outcome: 'failed' }] })],
      prIssue: { 920: 405 },
    })]);
    const issue = items.find((i) => i.id === 'acme/product#405')!;
    expect(issue).toMatchObject({ listed: true, status: 'waiting', note: 'checks fallando en #920', pr: { number: 920, author: 'valeria' }, prs: [920], runs: 1, lastRun: { runId: 'rv' } });
    expect(items.some((i) => i.id === 'acme/product#920')).toBe(false);
  });

  it('keeps the exploration PR pinned, a PR without an issue unlisted and a closed issue ronin worked on listed', () => {
    const items = buildItems([REPO], [
      run({ runId: 'a', taskType: 'external-review', prNumber: 722 }),
      run({ runId: 'b', taskType: 'issue-request', issueNumber: 300 }),
    ], [github({ prs: [pr({ number: 911, headRefName: 'ronin/exploration/2026-10-16' }), pr({ number: 722, headRefName: 'feat/scanner', author: 'oskr' })] })]);
    expect(Object.fromEntries(items.map((i) => [i.id, [i.kind, i.listed, i.pinned ?? false]]))).toEqual({
      'acme/product#911': ['pr', true, true],
      'acme/product#722': ['pr', false, false],
      'acme/product#300': ['issue', true, false],
    });
  });

  it("stops listing an issue ronin worked on once it's closed, and keeps one whose state is unknown", () => {
    const items = buildItems([REPO], [
      run({ runId: 'a', taskType: 'implement-slice', issueNumber: 300 }),
      run({ runId: 'b', taskType: 'issue-request', issueNumber: 301 }),
      run({ runId: 'c', taskType: 'issue-request', issueNumber: 302 }),
    ], [github({ closed: { 300: 'completed', 301: 'not_planned' } })]);
    expect(Object.fromEntries(items.map((i) => [i.id, [i.github, i.listed]]))).toEqual({
      'acme/product#300': ['completed', false],
      'acme/product#301': ['not_planned', false],
      'acme/product#302': [undefined, true],
    });
  });

  it('says when the PR has conflicts', () => {
    expect(prNote(pr({ number: 9, mergeable: 'CONFLICTING' }))).toBe('conflictos en #9');
  });
});

describe('buildItems', () => {
  it("counts a run on a slice's PR alone as the issue's, not as an item of its own", () => {
    const items = buildItems([REPO], [
      run({ runId: 'c', taskType: 'resolve-conflicts', prNumber: 894, state: 'running', startedAt: '2026-10-16T12:00:00Z' }),
      run({ runId: 'i', issueNumber: 879, sliceIndex: 1, startedAt: '2026-10-16T11:00:00Z' }),
    ], [github({ issues: [ISSUE_879], prs: [pr({ number: 894 })] })]);
    expect(items.map((item) => item.id)).toEqual(['acme/product#879']);
    expect(items[0]).toMatchObject({ status: 'running', runs: 2, lastRun: { runId: 'c' } });
  });

  it("shows an issue ronin manages with its slices and what it's waiting for, even with no recent runs", () => {
    const [item] = buildItems([REPO], [], [github({
      issues: [ISSUE_879],
      prs: [pr({ number: 894, checks: [{ name: 'unit', outcome: 'passed' }, { name: 'e2e', outcome: 'pending' }] })],
    })]);
    expect(item).toMatchObject({ id: 'acme/product#879', kind: 'issue', title: 'Validar stock y reservar', status: 'waiting', note: 'checks corriendo en #894', runs: 0 });
    expect(item.slices!.map((s) => [s.status, s.checks])).toEqual([['merged', undefined], ['open', 'pending'], ['pending', undefined]]);
    expect(item.pr?.number).toBe(894);
  });

  it('marks it running while one of its runs is, and keeps its last run', () => {
    const [item] = buildItems([REPO], [run({ issueNumber: 879, state: 'running', runId: 'live' })], [github({ issues: [ISSUE_879] })]);
    expect(item).toMatchObject({ status: 'running', runs: 1, lastRun: { runId: 'live' } });
    expect(item.note).toBeUndefined();
  });

  it('shows a blocked issue with the reason ronin kept, and its preview', () => {
    const block = { reason: 'e2e falla 3 veces', url: 'https://github.com/acme/product/issues/879', at: '2026-10-16T09:00:00Z' };
    const [item] = buildItems([REPO], [], [github({
      issues: [{ ...ISSUE_879, status: 'blocked' }],
      prs: [pr({ number: 894 })],
      previews: [{ prNumber: 894, appName: 'backoffice', url: 'https://media.ts.net:20001', sha: 'abc1234' }],
      blocks: { 879: block },
    })]);
    expect(item).toMatchObject({ status: 'blocked', block, preview: { prNumber: 894 } });
  });

  it('ignores a block reason once the issue is not blocked anymore', () => {
    const [item] = buildItems([REPO], [], [github({ issues: [ISSUE_879], blocks: { 879: { reason: 'viejo', url: 'u', at: 'x' } } })]);
    expect(item.block).toBeUndefined();
  });

  it("keeps recent runs about anything else, titled from GitHub when it's an open PR", () => {
    const items = buildItems([REPO], [
      run({ taskType: 'external-review', prNumber: 412, runId: 'rev' }),
      run({ taskType: 'update-changelog', label: 'release v1.2.3', runId: 'chg', startedAt: '2026-10-16T09:00:00Z' }),
    ], [github({ prs: [pr({ number: 412, title: 'Agenda: turnos dobles', author: 'mfernandez', headRefName: 'agenda/dobles' })] })]);
    expect(items.map((i) => [i.id, i.kind, i.title])).toEqual([
      ['acme/product#412', 'pr', 'Agenda: turnos dobles'],
      ['acme/product:update-changelog:release v1.2.3', 'other', 'release v1.2.3'],
    ]);
  });

  it("still shows a repo's runs when its GitHub read failed", () => {
    const items = buildItems([REPO], [run({ issueNumber: 879, sliceTitle: 'Validar al confirmar' })], [undefined]);
    expect(items).toMatchObject([{ id: 'acme/product#879', title: 'Validar al confirmar', status: 'ok' }]);
  });

  it('lists the running first, then the blocked, then what waits', () => {
    const items = buildItems([REPO], [run({ issueNumber: 3, state: 'running' })], [github({
      issues: [{ ...ISSUE_879, number: 1, slices: [] }, { ...ISSUE_879, number: 2, status: 'blocked', slices: [] }, { ...ISSUE_879, number: 3, slices: [] }],
    })]);
    expect(items.map((i) => [i.number, i.status])).toEqual([[3, 'running'], [2, 'blocked'], [1, 'waiting']]);
  });

  it('includes the open exploration PR', () => {
    const [item] = buildItems([REPO], [], [github({ prs: [pr({ number: 878, title: 'Exploración', headRefName: 'ronin/exploration/2026-W42' })] })]);
    expect(item).toMatchObject({ id: 'acme/product#878', kind: 'pr', status: 'waiting', note: 'PR de exploración abierto' });
  });
});

describe("buildItems — GitHub's state (#129)", () => {
  it('says how each item stands on GitHub: open issues, open or draft PRs, and the ones that closed since ronin worked on them', () => {
    const items = buildItems([REPO], [
      run({ runId: 'a', issueNumber: 870 }),
      run({ runId: 'b', issueNumber: 871 }),
      run({ runId: 'c', prNumber: 880 }),
      run({ runId: 'd', prNumber: 882 }),
      run({ runId: 'e', prNumber: 990 }),
      run({ runId: 'f', issueNumber: 12 }),
    ], [github({
      issues: [ISSUE_879],
      openIssues: [{ number: 879, title: 'Validar stock y reservar', url: 'u', labels: ['ronin'] }],
      prs: [pr({ number: 894, isDraft: true }), pr({ number: 990, headRefName: 'otra' })],
      closed: { 870: 'completed', 871: 'not_planned', 880: 'merged', 882: 'closed' },
    })]);
    const state = Object.fromEntries(items.map((i) => [i.number, i.github]));
    expect(state).toEqual({ 879: 'open', 870: 'completed', 871: 'not_planned', 880: 'merged', 882: 'closed', 990: 'open', 12: undefined });
    expect(items.find((i) => i.number === 879)?.slices?.map((s) => [s.status, s.draft])).toEqual([['merged', undefined], ['open', true], ['pending', undefined]]);
  });
});

describe('prNote', () => {
  it('says what an open PR waits for', () => {
    expect(prNote(pr({ checks: [{ name: 'e2e', outcome: 'failed' }] }))).toBe('checks fallando en #1');
    expect(prNote(pr({ reviewDecision: 'APPROVED', checks: [{ name: 'e2e', outcome: 'passed' }] }))).toBe('aprobado, falta el merge de #1');
    expect(prNote(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe('cambios pedidos en #1');
    expect(prNote(pr({}))).toBe('esperando review en #1');
  });
});

describe('itemRunKeys', () => {
  const gh = github({ issues: [ISSUE_879] });
  it("is an issue's own key plus its slices' PRs, and just the item's own for anything else", () => {
    expect(itemRunKeys('acme/product#879', gh)).toEqual(['acme/product#879', 'acme/product#881', 'acme/product#894']);
    expect(itemRunKeys('acme/product#894', gh)).toEqual(['acme/product#894']);
    expect(itemRunKeys('acme/product#879', undefined)).toEqual(['acme/product#879']);
    expect(itemRunKeys('acme/product:update-changelog:v1', gh)).toEqual(['acme/product:update-changelog:v1']);
  });
});
