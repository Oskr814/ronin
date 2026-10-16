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
  return { repo: REPO, fetchedAt: '2026-10-16T10:00:00Z', issues: [], prs: [], previews: [], blocks: {}, ...fields };
}

const ISSUE_879 = {
  number: 879, title: 'Validar stock y reservar', url: 'https://github.com/acme/product/issues/879', status: 'in-progress' as const, direct: false,
  slices: [
    { index: 0, title: 'Reserva en el modelo', checked: true, prNumber: 881 },
    { index: 1, title: 'Validar al confirmar', checked: false, prNumber: 894 },
    { index: 2, title: 'Liberar vencidas', checked: false, prNumber: null },
  ],
};

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
      previews: [{ prNumber: 894, appName: 'backoffice', url: 'https://media.ts.net:20001' }],
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
