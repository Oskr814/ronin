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
};
