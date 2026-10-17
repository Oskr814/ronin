import { describe, it, expect } from 'vitest';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withVersions } from './static.js';

describe('withVersions', () => {
  it("names each local script and stylesheet with its content's hash, which changes with it", () => {
    const root = mkdtempSync(join(tmpdir(), 'ronin-static-'));
    writeFileSync(join(root, 'portal.js'), 'console.log(1)');
    writeFileSync(join(root, 'portal.css'), 'body{}');
    const html = '<link rel="stylesheet" href="/portal.css"><script src="/portal.js"></script><script src="/missing.js"></script><link rel="icon" href="/favicon.svg"><script src="https://cdn.example/x.js"></script>';
    const first = withVersions(html, root);
    expect(first).toMatch(/href="\/portal\.css\?v=[0-9a-f]{10}"/);
    expect(first).toMatch(/src="\/portal\.js\?v=[0-9a-f]{10}"/);
    // Left alone: a file that isn't there, what isn't JS or CSS, another site.
    for (const kept of ['src="/missing.js"', 'href="/favicon.svg"', 'src="https://cdn.example/x.js"']) expect(first).toContain(kept);
    writeFileSync(join(root, 'portal.js'), 'console.log(2)');
    utimesSync(join(root, 'portal.js'), new Date(), new Date(Date.now() + 5000));
    const second = withVersions(html, root);
    expect(second.match(/portal\.js\?v=(\w+)/)?.[1]).not.toBe(first.match(/portal\.js\?v=(\w+)/)?.[1]);
    expect(second.match(/portal\.css\?v=(\w+)/)?.[1]).toBe(first.match(/portal\.css\?v=(\w+)/)?.[1]);
  });
});
