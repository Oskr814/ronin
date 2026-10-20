import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { log } from './logger.js';
import { logsDir } from './run-files.js';

// Each Claude account's last known usage, for the dashboard's status bar
// (#65). The source is the rate_limit_event every
// `claude -p --output-format stream-json` run emits near its start: the
// account's 5-hour and weekly windows, as a fraction used and when each
// resets. Nothing is asked of Anthropic on top of the runs ronin already
// does, so an account without recent runs shows an old figure — with its
// measuredAt, so the page can say how old.
//
// Not used: the endpoint Claude Code's /usage reads (/api/oauth/usage). It's
// undocumented, and with an expired access token it would have to refresh it,
// racing Claude Code itself over the same .credentials.json.

export interface UsageWindow {
  utilization: number; // 0..1
  resetsAt: string; // ISO
}

export interface AccountUsage {
  account: string;
  claudeConfigDir: string;
  measuredAt: string;
  status?: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  // Set when a run ended on ClaudeUsageLimitError: the account has no quota
  // until the window that ran out resets. Cleared by the next measurement.
  limitHitAt?: string;
}

// ".claude-redmotos" → "redmotos": the config dirs are named after the
// account they log into (repos.json). An empty dir is Claude Code's default.
export function accountName(claudeConfigDir: string): string {
  if (!claudeConfigDir) return 'default';
  return basename(claudeConfigDir).replace(/^\.?claude-?/, '') || 'default';
}

function usagePath(account: string): string {
  return join(logsDir(), 'usage', `${account}.json`);
}

// Every measurement too, one line each, oldest first: how full each window
// got before it reset, for the subscription's use in Métricas. Its own
// folder, so the readers of usage/*.json never take it for an account.
export const usageHistoryPath = (account: string) => join(logsDir(), 'usage', 'history', `${account}.jsonl`);

export interface UsageMeasurement {
  at: string;
  status?: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  // The run that hit the account's limit, instead of a measurement.
  limitHit?: true;
}

function appendHistory(account: string, entry: UsageMeasurement): void {
  mkdirSync(join(logsDir(), 'usage', 'history'), { recursive: true });
  appendFileSync(usageHistoryPath(account), `${JSON.stringify(entry)}\n`);
}

// Oldest first; a line that can't be read (cut by a crash) is skipped.
export function readUsageHistory(account: string): UsageMeasurement[] {
  let text: string;
  try {
    text = readFileSync(usageHistoryPath(account), 'utf8');
  } catch {
    return [];
  }
  const entries: UsageMeasurement[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as UsageMeasurement);
    } catch {
      // Half a line.
    }
  }
  return entries;
}

function toWindow(raw: any): UsageWindow | undefined {
  if (typeof raw?.utilization !== 'number' || typeof raw?.resetsAt !== 'number') return undefined;
  return { utilization: raw.utilization, resetsAt: new Date(raw.resetsAt * 1000).toISOString() };
}

// Written whole and renamed into place: the dashboard never reads half a file.
function write(usage: AccountUsage): void {
  const path = usagePath(usage.account);
  mkdirSync(join(logsDir(), 'usage'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(usage, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readAccountUsage(account: string): AccountUsage | null {
  try {
    return JSON.parse(readFileSync(usagePath(account), 'utf8')) as AccountUsage;
  } catch {
    return null;
  }
}

// Never throws: a usage figure that can't be written must never fail the run
// that reported it.
export function recordRateLimit(claudeConfigDir: string, info: any, now = new Date()): void {
  try {
    const windows = info?.unifiedWindows ?? {};
    const usage: AccountUsage = {
      account: accountName(claudeConfigDir),
      claudeConfigDir,
      measuredAt: now.toISOString(),
      ...(typeof info?.status === 'string' ? { status: info.status } : {}),
    };
    const fiveHour = toWindow(windows.five_hour);
    const sevenDay = toWindow(windows.seven_day);
    if (fiveHour) usage.fiveHour = fiveHour;
    if (sevenDay) usage.sevenDay = sevenDay;
    write(usage);
    if (fiveHour || sevenDay) {
      appendHistory(usage.account, { at: usage.measuredAt, ...(usage.status ? { status: usage.status } : {}), ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) });
    }
  } catch (error) {
    log.error('no se pudo guardar el uso de la cuenta de Claude', error);
  }
}

export function recordUsageLimitHit(claudeConfigDir: string, now = new Date()): void {
  try {
    const account = accountName(claudeConfigDir);
    const previous = readAccountUsage(account);
    write({ ...(previous ?? { account, claudeConfigDir, measuredAt: now.toISOString() }), limitHitAt: now.toISOString() });
    appendHistory(account, { at: now.toISOString(), limitHit: true });
  } catch (error) {
    log.error('no se pudo guardar el límite de uso de la cuenta de Claude', error);
  }
}
