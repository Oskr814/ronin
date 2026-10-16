import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gh = vi.hoisted(() => ({ listFileReviewComments: vi.fn() }));
vi.mock('../../core/github.js', () => gh);
vi.mock('../../core/repo-context.js', () => ({ withActiveRepo: (_entry: unknown, fn: () => unknown) => fn(), activeRepo: () => ({ productRepo: 'acme/product' }) }));
vi.mock('../../core/config.js', () => ({ config: { dashboard: { githubTtlSeconds: 60 }, githubLogin: 'ronin-agent', worktreeBaseRef: 'origin/main' } }));

import { explorationReview, isExplorationPr, resetExplorationCache } from './dashboard-exploration.js';
import { serializeFinding, type Finding } from '../../exploration/memory.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const BRANCH = 'ronin/exploration/2026-10-14';
const DIR = 'docs/exploration/backoffice';
const img = (sha: string, name: string) => `https://github.com/acme/product/blob/${sha}/backoffice/run/${name}?raw=true`;

function finding(id: string, titulo: string, despues?: string, extra: Partial<Finding> = {}): Finding {
  const body = [
    `## ${titulo}`, '', '**Bug** · gravedad `bug` · mobile · Quitar productos', '',
    '### Cómo reproducirlo', '', '1. Abrir el catálogo', '2. Quitar un producto', '',
    '**Qué pasa:** Aparece un error genérico', '', '**Qué se esperaba:** Un aviso claro', '',
    '### Evidencia', '', '- red: DELETE /CatalogueProduct/1 → 400', '',
    `**Antes**: el error\n\n<img src="${img('aaa1111', 'antes-1.png')}" alt="el error" width="320">`, '',
    '### Propuesta', '', 'Mostrar el motivo del servidor', '',
    ...(despues ? [`**Después**: el aviso\n\n<img src="${despues}" alt="el aviso" width="320">`, ''] : []),
  ].join('\n');
  return { id, tipo: 'hallazgo', titulo, funcion: 'catalogos.quitar', senal: 'bug', gravedad: 'bug', charter: 'concurrencia', viewport: 'mobile', rol: 'Admin', semilla: 1, fecha: '2026-10-14', estado: 'propuesto', huella: `catalogos.quitar|${id}|x`, body, ...extra };
}

let clone: string;
const entry = () => ({ productRepo: 'acme/product', productRepoPath: clone }) as any;
const pr = { number: 840, headRefName: BRANCH, baseRefName: 'main' };

async function put(path: string, text: string) {
  await mkdir(join(clone, path, '..'), { recursive: true });
  await writeFile(join(clone, path), text);
}

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ronin-dashboard-exploration-'));
  const remote = join(base, 'remote.git');
  clone = join(base, 'clone');
  git(base, 'init', '-q', '--bare', remote);
  git(base, 'clone', '-q', remote, clone);
  for (const key of ['user.email', 'user.name']) git(clone, 'config', key, 'r');
  // On the base: a finding of an earlier PR, already approved.
  await put(`${DIR}/findings/F-0001-viejo.md`, serializeFinding(finding('F-0001', 'Viejo', undefined, { estado: 'aprobado', issue: 801 })));
  await put(`${DIR}/inventory.yml`, 'funciones: []\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'base');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');

  // The exploration PR: two new findings, the run and the inventory; the old
  // finding gets its issue number written again (it shows in the diff).
  git(clone, 'checkout', '-q', '-b', BRANCH);
  await put(`${DIR}/findings/F-0001-viejo.md`, serializeFinding(finding('F-0001', 'Viejo', undefined, { estado: 'aprobado', issue: 802 })));
  await put(`${DIR}/findings/F-0002-quitar-da-error.md`, serializeFinding(finding('F-0002', 'Quitar da error', img('aaa1111', 'despues.png'))));
  await put(`${DIR}/findings/F-0003-fecha-congelada.md`, serializeFinding(finding('F-0003', 'Fecha congelada', undefined, { estado: 'rechazado', motivo: 'Muy poco probable' })));
  await put(`${DIR}/runs/2026-10-14-194714.md`, '# Corrida\n');
  await put(`${DIR}/inventory.yml`, 'funciones: [x]\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'corrida');
  // A comment asked to fix F-0002: new title (the file moves) and a new after.
  await rm(join(clone, `${DIR}/findings/F-0002-quitar-da-error.md`));
  await put(`${DIR}/findings/F-0002-quitar-un-producto-ya-borrado.md`, serializeFinding(finding('F-0002', 'Quitar un producto ya borrado', img('bbb2222', 'despues.png'))));
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'feedback');
  git(clone, 'push', '-q', 'origin', `HEAD:${BRANCH}`);
  git(clone, 'checkout', '-q', 'main');
});

beforeEach(() => {
  resetExplorationCache();
  gh.listFileReviewComments.mockReset().mockResolvedValue([
    { id: 2, inReplyToId: 1, path: `${DIR}/findings/F-0002-quitar-da-error.md`, body: 'Listo, ajusté la propuesta.', authorLogin: 'ronin-agent', reactionsEyes: 0, createdAt: '2026-10-14T19:00:00Z' },
    { id: 1, path: `${DIR}/findings/F-0002-quitar-da-error.md`, body: '@ronin-agent cambiá el mensaje', authorLogin: 'Oskr814', reactionsEyes: 0, createdAt: '2026-10-14T18:58:00Z', url: 'https://github.com/acme/product/pull/840#discussion_r1' },
    { id: 3, path: `${DIR}/inventory.yml`, body: 'ojo acá', authorLogin: 'Oskr814', reactionsEyes: 0 },
  ]);
});

describe('explorationReview', () => {
  it('brings only the findings the PR adds, each read into its parts', async () => {
    const review = await explorationReview(entry(), pr);
    expect(review.error).toBeUndefined();
    expect(review.fichas.map((f) => f.id)).toEqual(['F-0002', 'F-0003']);
    const f = review.fichas[0];
    expect(f).toMatchObject({
      app: 'backoffice', titulo: 'Quitar un producto ya borrado', estado: 'propuesto', viewport: 'mobile', functionName: 'Quitar productos',
      pasos: ['Abrir el catálogo', 'Quitar un producto'], observado: 'Aparece un error genérico', esperado: 'Un aviso claro',
      evidencia: [{ tipo: 'red', detalle: 'DELETE /CatalogueProduct/1 → 400' }], antes: [{ url: img('aaa1111', 'antes-1.png'), nota: 'el error' }],
      propuesta: 'Mostrar el motivo del servidor', despues: { url: img('bbb2222', 'despues.png'), nota: 'el aviso' },
      url: `https://github.com/acme/product/blob/ronin/exploration/2026-10-14/${DIR}/findings/F-0002-quitar-un-producto-ya-borrado.md`,
    });
    expect(review.fichas[1]).toMatchObject({ estado: 'rechazado', motivo: 'Muy poco probable' });
    expect(review.runs).toEqual([{ app: 'backoffice', id: '2026-10-14-194714', url: `https://github.com/acme/product/blob/ronin/exploration/2026-10-14/${DIR}/runs/2026-10-14-194714.md` }]);
  });

  it('keeps the after ronin replaced, across the rename of an edited title', async () => {
    const [f, rejected] = (await explorationReview(entry(), pr)).fichas;
    expect(f.despuesAnterior).toEqual({ url: img('aaa1111', 'despues.png'), nota: 'el aviso' });
    expect(rejected.despuesAnterior).toBeUndefined();
  });

  it("puts each finding's thread on it, oldest first, by id even under its old file name", async () => {
    const [f, rejected] = (await explorationReview(entry(), pr)).fichas;
    expect(f.comments).toEqual([
      { id: 1, author: 'Oskr814', body: '@ronin-agent cambiá el mensaje', createdAt: '2026-10-14T18:58:00Z', url: 'https://github.com/acme/product/pull/840#discussion_r1' },
      { id: 2, replyTo: 1, author: 'ronin-agent', body: 'Listo, ajusté la propuesta.', createdAt: '2026-10-14T19:00:00Z' },
    ]);
    expect(rejected.comments).toEqual([]);
  });

  it('still shows the findings when GitHub fails for the threads', async () => {
    gh.listFileReviewComments.mockRejectedValueOnce(new Error('HTTP 502'));
    const review = await explorationReview(entry(), pr);
    expect(review.fichas).toHaveLength(2);
    expect(review.error).toContain('HTTP 502');
  });

  it('is cached until the TTL or a run of the item changes it', async () => {
    const now = Date.now();
    await explorationReview(entry(), pr, 0, now);
    await explorationReview(entry(), pr, 0, now + 1000);
    expect(gh.listFileReviewComments).toHaveBeenCalledTimes(1);
    // Stale: the old copy answers right away and a new read starts behind it.
    expect((await explorationReview(entry(), pr, now + 5000, now + 6000)).fichas).toHaveLength(2);
    await vi.waitFor(() => expect(gh.listFileReviewComments).toHaveBeenCalledTimes(2));
  });

  it('tells an exploration PR by its branch', () => {
    expect(isExplorationPr({ headRefName: BRANCH })).toBe(true);
    expect(isExplorationPr({ headRefName: 'ronin/844/slice-1' })).toBe(false);
  });
});
