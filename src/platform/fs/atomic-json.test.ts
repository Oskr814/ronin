import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJson, withJson, writeFileAtomic, writeFileAtomicSync, writeJson } from './atomic-json.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ronin-atomic-json-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates the folder and leaves only the file, nothing aside', async () => {
    await writeFileAtomic(join(dir, 'a', 'b.txt'), 'hola');
    writeFileAtomicSync(join(dir, 'c', 'd.txt'), 'chau');
    expect(await readFile(join(dir, 'a', 'b.txt'), 'utf8')).toBe('hola');
    expect(await readFile(join(dir, 'c', 'd.txt'), 'utf8')).toBe('chau');
    expect(await readdir(join(dir, 'a'))).toEqual(['b.txt']);
  });

  it('keeps a private one to this user', async () => {
    await writeJson(join(dir, 'p', 'x.json'), { a: 1 });
    expect((await stat(join(dir, 'p', 'x.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'p'))).mode & 0o777).toBe(0o700);
  });
});

describe('readJson', () => {
  it('gives the default only for a missing file, and throws for one that does not read', async () => {
    expect(await readJson(join(dir, 'none.json'), () => ({ last: 0 }))).toEqual({ last: 0 });
    await writeFile(join(dir, 'torn.json'), '{"last": ');
    await expect(readJson(join(dir, 'torn.json'), () => ({ last: 0 }))).rejects.toThrow();
  });
});

describe('withJson', () => {
  it('takes turns: changes at once all land', async () => {
    const path = join(dir, 'counter.json');
    await Promise.all(Array.from({ length: 20 }, () => withJson(path, () => ({ last: 0 }), (c) => ++c.last)));
    expect(await readJson(path, () => ({ last: 0 }))).toEqual({ last: 20 });
  });

  it('writes only when something changed', async () => {
    const path = join(dir, 'same.json');
    await withJson(path, () => ({ last: 0 }), () => {});
    await expect(stat(path)).rejects.toThrow();
  });
});
