import { describe, it, expect, beforeEach } from 'vitest';
import { resetTickMetrics, recordAgentRun, getTickAgentMetrics } from './metrics.js';

beforeEach(() => {
  resetTickMetrics();
});

describe('tick agent-run metrics', () => {
  it('starts at zero after a reset', () => {
    expect(getTickAgentMetrics()).toEqual({ agentRuns: 0, agentRunsDurationMs: 0 });
  });

  it('accumulates count and duration across multiple runs', () => {
    recordAgentRun(1000);
    recordAgentRun(2500);

    expect(getTickAgentMetrics()).toEqual({ agentRuns: 2, agentRunsDurationMs: 3500 });
  });
});
