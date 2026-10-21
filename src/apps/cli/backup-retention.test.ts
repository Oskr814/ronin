import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The retention of scripts/backup.sh: 7 daily backups and, before them, the
// newest of each of 4 weeks.
const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'backup.sh');

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function days(from: string, count: number): string[] {
  const start = new Date(`${from}T12:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() - i * 86_400_000).toISOString().slice(0, 10));
}

describe('backup retention', () => {
  it('keeps 7 daily and the newest of 4 weeks before them', () => {
    dir = mkdtempSync(join(tmpdir(), 'ronin-backups-'));
    // 60 days back from a Wednesday.
    for (const day of days('2026-10-21', 60)) mkdirSync(join(dir, day));
    mkdirSync(join(dir, 'otra-cosa'));
    execFileSync('bash', [SCRIPT, '--prune', dir]);
    expect(readdirSync(dir).sort().reverse()).toEqual([
      'otra-cosa',
      // The last 7 days (weeks 43 and 42 of 2026).
      '2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17', '2026-10-16', '2026-10-15',
      // The newest of weeks 41, 40, 39 and 38: their Sundays.
      '2026-10-11', '2026-10-04', '2026-09-27', '2026-09-20',
    ]);
  });

  it('leaves a short history alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'ronin-backups-'));
    for (const day of days('2026-10-21', 3)) mkdirSync(join(dir, day));
    execFileSync('bash', [SCRIPT, '--prune', dir]);
    expect(readdirSync(dir)).toHaveLength(3);
  });
});
