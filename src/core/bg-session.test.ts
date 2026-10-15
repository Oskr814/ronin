import { describe, it, expect, vi } from 'vitest';

vi.mock('./config.js', () => ({ config: { claudeCommand: 'claude', claudeConfigDir: '' } }));
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({}) }));

import { parseBackgroundId, stripAnsi } from './bg-session.js';

describe('parseBackgroundId', () => {
  it('reads the id `claude --bg` prints', () => {
    expect(parseBackgroundId('Starting background service…\nbackgrounded · 7835badf\n  claude attach 7835badf')).toBe('7835badf');
    expect(parseBackgroundId('error')).toBeUndefined();
  });
});

describe('stripAnsi', () => {
  it('leaves the text of a session log', () => {
    expect(stripAnsi('\x1b[38;2;153;153;153m●listo\x1b[39m')).toBe('●listo');
  });
});
