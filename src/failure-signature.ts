import { createHash } from 'node:crypto';

// A fingerprint of *why* a PR's CI is failing, so tick.ts can tell a fix-e2e
// that changed nothing (same failure again) from one that made progress
// (test A now passes, test B fails) — the attempt counter alone can't. Same
// idea as fabro's failure signatures: normalize away what varies between
// runs of the same root cause (line numbers, durations, ids, hashes) and
// count how often each fingerprint comes back. See docs/BLOCKING.md.

export interface FailedCheck {
  name: string;
  // The job's log (the Actions API's `jobs/<id>/logs`, not `gh run view
  // --log-failed`, which comes back empty for some repos); empty when
  // there's none to read (a status from outside GitHub Actions, or the
  // fetch failed).
  log: string;
}

export interface FailureSignature {
  hash: string;
  // The first error line, for the blocker email: what kept failing.
  sample: string;
}

const LINE_MAX = 240;
const LINES_PER_CHECK_MAX = 20;

const ANSI = /\x1b\[[0-9;]*m/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\s?/;
// Every Actions job that fails ends with this line; it says nothing about why.
const GENERIC_EXIT = /^process completed with exit code/i;

function normalize(line: string): string {
  return line
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LINE_MAX);
}

// The lines that say what failed, out of a log that is mostly noise (lint
// warnings, passing tests whose names contain "error"): GitHub Actions'
// own `##[error]` annotations, which every tool's failure ends up as, and
// the lines that name a failing test: "FAIL <test>" from vitest/jest,
// "<test> [FAIL]" from xUnit.
const TEST_FAILURE = /^FAIL\s|\[FAIL\]$/;

export function extractErrorLines(log: string): string[] {
  const lines = new Set<string>();
  for (const raw of log.split('\n')) {
    const text = raw.replace(ANSI, '').replace(TIMESTAMP, '').trim();
    let error: string | undefined;
    if (text.startsWith('##[error]')) error = text.slice('##[error]'.length).trim();
    else if (TEST_FAILURE.test(text)) error = text;
    if (error && !GENERIC_EXIT.test(error)) lines.add(normalize(error));
  }
  return [...lines].sort().slice(0, LINES_PER_CHECK_MAX);
}

function isTestFailure(line: string): boolean {
  return /: fail\s|\[fail\]$/.test(line);
}

export function failureSignature(checks: FailedCheck[]): FailureSignature {
  const parts = checks
    .map((c) => ({ name: c.name, lines: extractErrorLines(c.log) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const text = parts.map((p) => [p.name, ...p.lines].join('\n')).join('\n\n');
  // A failing test's name says more than a tool's exit line, so it wins.
  const sample = parts.flatMap((p) => p.lines.map((l) => `${p.name}: ${l}`))
    .sort((a, b) => Number(isTestFailure(b)) - Number(isTestFailure(a)))[0];
  return {
    hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
    sample: sample ?? parts.map((p) => p.name).join(', '),
  };
}
