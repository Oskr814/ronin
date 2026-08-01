type Level = 'INFO' | 'ERROR';

function line(level: Level, message: string): string {
  return `[${new Date().toISOString()}] ${level} ${message}`;
}

export const log = {
  info(message: string): void {
    console.log(line('INFO', message));
  },
  error(message: string, error?: unknown): void {
    console.error(line('ERROR', message), error ?? '');
  },
  // One JSON line per event, into the same daily log as info/error — no new
  // storage, queried later with jq/grep. Kept separate from info() (plain
  // text) so a metric line is trivial to pick out of a log full of prose.
  metric(event: string, fields: Record<string, unknown>): void {
    console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
  },
};
