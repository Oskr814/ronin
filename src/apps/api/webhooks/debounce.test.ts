import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventDebouncer } from './debounce.js';
import { comesInBursts } from './events.js';

const SHORT = 1000;
const BURST = 15000;

let start: ReturnType<typeof vi.fn>;
let debouncer: EventDebouncer;
beforeEach(() => {
  vi.useFakeTimers();
  start = vi.fn();
  debouncer = new EventDebouncer(start);
});
afterEach(() => vi.useRealTimers());

const scope = (flows: string[], resources = ['pr-12']) => ({ flows, resources }) as never;

describe('the debounce windows (#370)', () => {
  it('waits out a burst of check suites and starts one handler with every flow', () => {
    debouncer.schedule('acme/app', scope(['auto-merge']), BURST);
    vi.advanceTimersByTime(8000);
    debouncer.schedule('acme/app', scope(['issues']), BURST);
    vi.advanceTimersByTime(6999);
    expect(start).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1]).toEqual({ flows: ['auto-merge', 'issues'], resources: ['pr-12'] });
    expect(debouncer.open).toBe(0);
  });

  it('brings a check suite\'s window forward when a comment about the same PR comes in', () => {
    debouncer.schedule('acme/app', scope(['auto-merge']), BURST);
    vi.advanceTimersByTime(2000);
    debouncer.schedule('acme/app', scope(['pr-commands']), SHORT);
    vi.advanceTimersByTime(SHORT);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1]).toEqual({ flows: ['auto-merge', 'pr-commands'], resources: ['pr-12'] });
  });

  it('never makes a comment wait longer because a check suite came after it', () => {
    debouncer.schedule('acme/app', scope(['issues']), SHORT);
    debouncer.schedule('acme/app', scope(['auto-merge']), BURST);
    vi.advanceTimersByTime(SHORT);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1].flows).toEqual(['issues', 'auto-merge']);
  });

  it('keeps different PRs apart, each with its own window', () => {
    debouncer.schedule('acme/app', scope(['auto-merge'], ['pr-12']), BURST);
    debouncer.schedule('acme/app', scope(['pr-commands'], ['pr-13']), SHORT);
    vi.advanceTimersByTime(SHORT);
    expect(start.mock.calls.map((c) => c[1].resources)).toEqual([['pr-13']]);
    vi.advanceTimersByTime(BURST);
    expect(start.mock.calls.map((c) => c[1].resources)).toEqual([['pr-13'], ['pr-12']]);
  });

  it('gives the long window only to the deliveries that come in bursts', () => {
    expect(comesInBursts('check_suite')).toBe(true);
    expect(comesInBursts('workflow_run')).toBe(true);
    for (const event of ['issue_comment', 'pull_request_review_comment', 'pull_request_review', 'pull_request', 'issues']) {
      expect(comesInBursts(event)).toBe(false);
    }
  });
});
