import { describe, it, expect } from 'vitest';
import type { PortalRequest } from '../../portal/requests.js';
import type { RunSummary } from './dashboard-data.js';
import { activity, requestRuns, waitsOn } from './dashboard-portal.js';

const request = (over: Partial<PortalRequest> = {}): PortalRequest => ({
  number: 2, userId: 'u', repo: 'a/b', app: 'web', title: 'Foto', status: 'proposed', questions: 0,
  messages: [
    { id: 1, from: 'person', text: 'Quiero la foto', images: ['1-1.png'], at: '2026-10-17T17:24:07Z' },
    { id: 2, from: 'ronin', text: 'Va', images: [], at: '2026-10-17T17:25:06Z' },
    { id: 3, from: 'ronin', text: 'Así quedaría', images: ['p1-antes-1.png'], at: '2026-10-17T17:31:45Z' },
  ],
  verdict: { kind: 'minor', summary: 's', at: '2026-10-17T17:25:06Z' },
  prototypes: [{ round: 1, summary: 'p', messageId: 3, at: '2026-10-17T17:31:45Z' }],
  createdAt: '2026-10-17T17:24:07Z', updatedAt: '2026-10-17T17:31:45Z',
  ...over,
});
const run = (over: Partial<RunSummary>): RunSummary => ({ runId: 'r', repo: 'a/b', taskType: 'portal-request', label: '', account: 'a', worktree: '/w', startedAt: '2026-10-17T17:24:09Z', state: 'ok', steps: 1, ...over });

describe("a portal request on the dashboard (#132)", () => {
  it('says who it waits on', () => {
    expect(waitsOn({ status: 'thinking' })).toBe('ronin');
    expect(waitsOn({ status: 'proposed' })).toBe('person');
    expect(waitsOn({ status: 'answered' })).toBeNull();
    expect(waitsOn({ status: 'approved' })).toBe('ronin');
    expect(waitsOn({ status: 'approved', pr: 9 })).toBe('team');
    expect(waitsOn({ status: 'big' })).toBe('ronin');
    expect(waitsOn({ status: 'big', issue: { number: 9, url: '' } })).toBe('team');
    expect(waitsOn({ status: 'done' })).toBeNull();
  });

  it("takes its own runs, and its issue's and its PR's", () => {
    const runs = [
      run({ runId: 'own', portalRequest: 2 }),
      run({ runId: 'other', portalRequest: 3 }),
      run({ runId: 'issue', taskType: 'fix-issue', issueNumber: 925 }),
      run({ runId: 'pr', taskType: 'fix-ci', prNumber: 928 }),
      run({ runId: 'elsewhere', repo: 'c/d', issueNumber: 925 }),
    ];
    expect(requestRuns(request(), runs).map((r) => r.runId)).toEqual(['own']);
    expect(requestRuns(request({ issue: { number: 925, url: '' }, pr: 928 }), runs).map((r) => r.runId)).toEqual(['own', 'issue', 'pr']);
  });

  it('puts its messages, events and runs in order, and marks the first message and the prototypes', () => {
    const { entries, untimed } = activity(request({ events: [{ kind: 'mail', to: 'person', subject: 'x', ok: true, at: '2026-10-17T17:25:06Z' }] }), [run({ portalRequest: 2 })]);
    expect(entries.map((e) => (e.type === 'event' ? e.event.kind : e.type))).toEqual(['message', 'run', 'message', 'mail', 'message']);
    expect(entries[0]).toMatchObject({ first: true });
    expect(entries.at(-1)).toMatchObject({ prototype: 1 });
    expect(untimed).toEqual([]);
  });

  it('without events (before #132), stands in with its verdict and decision, and its issue goes last', () => {
    const { entries, untimed } = activity(request({ status: 'big', decision: { kind: 'rejected', at: '2026-10-17T18:00:00Z' }, issue: { number: 921, url: '' } }), []);
    expect(entries.flatMap((e) => (e.type === 'event' ? [e.event.kind] : []))).toEqual(['classified', 'decided']);
    expect(untimed).toEqual([{ kind: 'issue', number: 921, team: true, at: '' }]);
  });
});
