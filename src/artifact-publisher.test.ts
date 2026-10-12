import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./config.js', () => ({ config: { claudeCommand: 'claude', claudeConfigDir: '' } }));
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({}) }));

import { inlineLocalImages, parseArtifactUrl, parseBackgroundId } from './artifact-publisher.js';

describe('parseArtifactUrl', () => {
  it('finds the URL in a background session log, through ANSI codes and decorations', () => {
    const log = '\x1b[38;2;153;153;153m●RONIN_ARTIFACT_URL=⧉https://claude.ai/artifact/46Ag2bfthPiYojt5fgQzfh\x1b[39m\nPrestidigitating…';
    expect(parseArtifactUrl(log)).toBe('https://claude.ai/artifact/46Ag2bfthPiYojt5fgQzfh');
  });

  it('accepts the claude.ai/code form and ignores a URL without the marker', () => {
    expect(parseArtifactUrl('RONIN_ARTIFACT_URL=https://claude.ai/code/artifact/0b9c-12ab')).toBe('https://claude.ai/code/artifact/0b9c-12ab');
    expect(parseArtifactUrl('Published https://claude.ai/artifact/abc')).toBeUndefined();
  });
});

describe('parseBackgroundId', () => {
  it('reads the id `claude --bg` prints', () => {
    expect(parseBackgroundId('Starting background service…\nbackgrounded · 7835badf\n  claude attach 7835badf')).toBe('7835badf');
    expect(parseBackgroundId('error')).toBeUndefined();
  });
});

describe('inlineLocalImages', () => {
  it('embeds local images as data URIs and leaves remote ones and missing ones alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ronin-artifact-'));
    try {
      await writeFile(join(dir, 'antes.png'), Buffer.from([1, 2, 3]));
      const html = '<img src="antes.png"><img src="https://x/y.png"><img src="falta.png">';
      expect(await inlineLocalImages(html, dir)).toBe('<img src="data:image/png;base64,AQID"><img src="https://x/y.png"><img src="falta.png">');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
