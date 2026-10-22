import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reclaimOutput } from './agent-task.js';

describe('reclaimOutput', () => {
  it("keeps the agent's regular files and drops every link", async () => {
    const root = await mkdtemp(join(tmpdir(), 'ronin-reclaim-'));
    const out = join(root, 'out');
    await mkdir(join(out, 'images'), { recursive: true });
    await writeFile(join(out, 'result.json'), '{"ok":true}');
    await writeFile(join(out, 'images', 'antes.png'), 'png');
    await writeFile(join(root, 'secreto'), 'del supervisor');
    await symlink(join(root, 'secreto'), join(out, 'findings.json'));
    await symlink(root, join(out, 'arriba'));

    await reclaimOutput(out);

    expect(await readFile(join(out, 'result.json'), 'utf8')).toBe('{"ok":true}');
    expect(await readFile(join(out, 'images', 'antes.png'), 'utf8')).toBe('png');
    expect((await readdir(out)).sort()).toEqual(['images', 'result.json']);
    expect((await lstat(out)).mode & 0o777).toBe(0o700);
    expect((await readdir(root)).sort()).toEqual(['out', 'secreto']);
  });
});
