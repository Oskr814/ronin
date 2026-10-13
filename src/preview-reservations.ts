import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

// What previews hold that has to be unique across every repo and every
// worker at once: a public port on the tailnet, and a slot of the per-app
// limit. Each is a file created with O_EXCL (`wx`), so two workers can never
// both get the same one, and its content names the preview worktree that
// owns it — a reservation whose worktree no longer exists is stale and gets
// taken over. See docs/DESIGN.md §12.

interface Owner {
  dir: string;
  prNumber: number;
}

async function readOwner(path: string): Promise<Owner | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Owner;
  } catch {
    return null;
  }
}

// Exclusive create; a reservation whose owner is gone is taken over.
async function claim(path: string, owner: Owner): Promise<boolean> {
  const current = existsSync(path) ? await readOwner(path) : null;
  if (current && !existsSync(current.dir)) await rm(path, { force: true });
  try {
    await writeFile(path, JSON.stringify(owner), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

async function ownedBy(dir: string, ownerDir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const owned: string[] = [];
  for (const name of names) {
    if ((await readOwner(join(dir, name)))?.dir === ownerDir) owned.push(name);
  }
  return owned;
}

export function parsePortRange(raw: string): { min: number; max: number } {
  const match = raw.trim().match(/^(\d+)-(\d+)$/);
  const [min, max] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
  if (!(min >= 1024 && max <= 65535 && min <= max)) throw new Error(`PREVIEW_PORT_RANGE inválido: "${raw}" (formato 20000-20999)`);
  return { min, max };
}

// Nothing else on the host may be listening there either: the range is what
// the tailnet policy opens to outside users, so a port some other process
// took is skipped, never published.
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

export class PreviewReservations {
  constructor(private readonly root: string) {}

  private portsDir(): string {
    return join(this.root, 'ports');
  }

  private slotsDir(): string {
    return join(this.root, 'slots');
  }

  async allocatePort(range: { min: number; max: number }, owner: Owner): Promise<number> {
    await mkdir(this.portsDir(), { recursive: true });
    for (let port = range.min; port <= range.max; port++) {
      const path = join(this.portsDir(), String(port));
      if (!(await claim(path, owner))) continue;
      if (await portIsFree(port)) return port;
      await rm(path, { force: true });
    }
    throw new Error(`no quedan puertos libres en el rango de previews (${range.min}-${range.max})`);
  }

  async releasePorts(ownerDir: string): Promise<void> {
    for (const name of await ownedBy(this.portsDir(), ownerDir)) await rm(join(this.portsDir(), name), { force: true });
  }

  // One of `max` slots for this repo's app. A preview that already holds one
  // (a second /preview on the same PR) keeps it. Returns the PRs holding
  // every slot when there's none left.
  async acquireSlot(key: string, max: number, owner: Owner): Promise<{ ok: true } | { ok: false; holders: number[] }> {
    await mkdir(this.slotsDir(), { recursive: true });
    const prefix = `${key}--`;
    const mine = (await ownedBy(this.slotsDir(), owner.dir)).some((name) => name.startsWith(prefix));
    if (mine) return { ok: true };
    for (let n = 1; n <= max; n++) {
      if (await claim(join(this.slotsDir(), `${prefix}${n}`), owner)) return { ok: true };
    }
    const holders: number[] = [];
    for (let n = 1; n <= max; n++) {
      const holder = await readOwner(join(this.slotsDir(), `${prefix}${n}`));
      if (holder) holders.push(holder.prNumber);
    }
    return { ok: false, holders };
  }

  async releaseSlots(ownerDir: string): Promise<void> {
    for (const name of await ownedBy(this.slotsDir(), ownerDir)) await rm(join(this.slotsDir(), name), { force: true });
  }
}
