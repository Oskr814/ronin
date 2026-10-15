import { describe, it, expect } from 'vitest';
import { extractErrorLines, failureSignature } from './failure-signature.js';

// Shaped like the Actions API's job log: an ISO timestamp per line, ANSI
// colors from the test runner, and plenty of noise around the failure.
function jobLog(failingTest: string, durationMs: number): string {
  return [
    '2026-10-14T03:37:46.5798213Z ##[warning]  58:19  warning  Unexpected any  @typescript-eslint/no-explicit-any',
    '2026-10-14T03:37:46.6611963Z ✖ 24 problems (0 errors, 24 warnings)',
    `2026-10-14T03:43:15.0118756Z    \x1b[33m✓\x1b[39m Form > shows frequency error on blur \x1b[33m ${durationMs}ms\x1b[39m`,
    `2026-10-14T03:43:15.0650577Z \x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/users/page.spec.tsx > EditUserPage > ${failingTest}`,
    `2026-10-14T03:43:15.0676282Z ##[error]Error: boom at line ${durationMs}`,
    '2026-10-14T03:43:15.0683616Z ##[error]Process completed with exit code 1.',
  ].join('\n');
}

describe('extractErrorLines', () => {
  it('keeps ##[error] annotations and failing tests, and drops warnings, passing tests and the generic exit line', () => {
    expect(extractErrorLines(jobLog('renders the page', 756))).toEqual([
      'error: boom at line <n>',
      'fail src/users/page.spec.tsx > edituserpage > renders the page',
    ]);
  });

  it('recognizes xUnit failures', () => {
    const log = '2026-10-14T01:59:48.4538716Z [xUnit.net 00:00:07.66]     Api.Tests.InvoiceTests.Should_Throw403 [FAIL]';
    expect(extractErrorLines(log)).toEqual(['[xunit.net <n>:<n>:<n>.<n>] api.tests.invoicetests.should_throw<n> [fail]']);
  });
});

describe('failureSignature', () => {
  it('is the same for the same failure across runs, whatever the timestamps, durations and line numbers', () => {
    const first = failureSignature([{ name: 'CI', log: jobLog('renders the page', 756) }]);
    const second = failureSignature([{ name: 'CI', log: jobLog('renders the page', 1203) }]);
    expect(second.hash).toBe(first.hash);
  });

  it('changes when a different test fails', () => {
    const first = failureSignature([{ name: 'CI', log: jobLog('renders the page', 756) }]);
    const second = failureSignature([{ name: 'CI', log: jobLog('shows a 404', 756) }]);
    expect(second.hash).not.toBe(first.hash);
  });

  it('does not depend on the order the checks come in', () => {
    const a = { name: 'Lint', log: '##[error]lint broke' };
    const b = { name: 'Tests', log: jobLog('renders the page', 1) };
    expect(failureSignature([a, b]).hash).toBe(failureSignature([b, a]).hash);
  });

  it('samples the failing test over a tool error, and falls back to the check names', () => {
    expect(failureSignature([{ name: 'CI', log: jobLog('renders the page', 1) }]).sample)
      .toBe('CI: fail src/users/page.spec.tsx > edituserpage > renders the page');
    expect(failureSignature([{ name: 'Deploy preview', log: '' }]).sample).toBe('Deploy preview');
  });
});
