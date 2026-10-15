import { describe, it, expect, vi } from 'vitest';

vi.mock('../core/config.js', () => ({ config: { worktreeBaseRef: 'origin/main', githubLogin: 'ronin-agent' } }));
vi.mock('../core/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', worktreeBaseRef: 'origin/odoo-main' }) }));
const listOpenPrsByHeadPrefix = vi.hoisted(() => vi.fn());
vi.mock('../core/github.js', () => ({ listOpenPrsByHeadPrefix: (...a: unknown[]) => listOpenPrsByHeadPrefix(...a) }));

import { batchOfBranch, currentBatch, explorationBranch, findingIssueKey, findingsAddedOverBase, renderDigest, renderFindingIssue } from './pr.js';
import type { Finding, FindingMeta } from './memory.js';

function meta(overrides: Partial<FindingMeta> = {}): FindingMeta {
  return {
    id: 'F-0007', tipo: 'hallazgo', titulo: 'Doble toque duplica el pedido', funcion: 'pedidos.confirmar', senal: 'bug', gravedad: 'bug',
    charter: 'interrupciones', viewport: 'mobile', rol: 'Sales', semilla: 83121, fecha: '2026-10-14', estado: 'propuesto',
    huella: 'pedidos.confirmar|doble-toque|duplicado', ...overrides,
  };
}

describe('batches', () => {
  it('names the branch after the batch and reads it back, old weekly ones included', () => {
    expect(explorationBranch('2026-10-12')).toBe('ronin/exploration/2026-10-12');
    expect(batchOfBranch('ronin/exploration/2026-10-12-2')).toBe('2026-10-12-2');
    expect(batchOfBranch('ronin/exploration/2026-W42')).toBe('2026-W42');
    expect(batchOfBranch('ronin/42/slice-1')).toBeUndefined();
  });
});

describe('currentBatch', () => {
  it('goes to the open exploration PR, the oldest if there are more', async () => {
    listOpenPrsByHeadPrefix.mockResolvedValue([
      { number: 801, headRefName: 'ronin/exploration/2026-10-14' },
      { number: 794, headRefName: 'ronin/exploration/2026-W42' },
    ]);
    expect(await currentBatch('2026-10-15')).toEqual({ batch: '2026-W42', prNumber: 794 });
  });
});

describe('renderFindingIssue', () => {
  it('carries the finding with its images, where it came from and a searchable key', () => {
    const finding: Finding = { ...meta(), body: '## Doble toque duplica el pedido\n\n### Cómo reproducirlo\n\n1. Tocar dos veces\n\n<img src="https://github.com/o/r/blob/abc/a.png?raw=true" alt="dos filas" width="320">' };
    const { title, body } = renderFindingIssue('backoffice', finding, 'https://github.com/o/r/blob/b/f.md');
    expect(title).toBe('Doble toque duplica el pedido');
    expect(body.startsWith('### Cómo reproducirlo')).toBe(true);
    expect(body).toContain('<img src="https://github.com/o/r/blob/abc/a.png?raw=true"');
    expect(body).toContain('semilla 83121');
    expect(body).toContain(findingIssueKey('backoffice', 'F-0007'));
    expect(findingIssueKey('backoffice', 'F-0007')).toBe('ronin-ficha:backoffice/F-0007');
  });
});

describe('renderDigest', () => {
  it('lists the findings this PR adds per app with their state, and how to review', () => {
    const memory = {
      dir: '/m',
      inventory: { funciones: [] },
      knowledge: '',
      findings: [
        meta(),
        meta({ id: 'F-0008', titulo: 'Idea: escanear | código', tipo: 'idea', gravedad: 'pulido', estado: 'rechazado', motivo: 'no hay lectores' }),
        meta({ id: 'F-0009', titulo: 'Con issue', issue: 812 }),
        meta({ id: 'F-0010', titulo: 'Seed roto', entorno: true }),
        meta({ id: 'F-0001', titulo: 'De un PR anterior', fecha: '2026-10-01' }),
      ],
    };
    const digest = renderDigest({
      since: '2026-10-12', branch: 'ronin/exploration/2026-10-12', repo: 'o/r',
      apps: [{ appName: 'backoffice', memory, findingIds: new Set(['F-0007', 'F-0008', 'F-0009', 'F-0010']), runs: ['2026-10-14-123'] }],
    });
    expect(digest).toContain('# Exploración de ronin — desde 2026-10-12');
    expect(digest).toContain('comentá en su ficha');
    expect(digest).toContain('rehago la captura del después');
    expect(digest).toContain('[F-0007](https://github.com/o/r/blob/ronin/exploration/2026-10-12/docs/exploration/backoffice/findings/F-0007-doble-toque-duplica-el-pedido.md)');
    expect(digest).toContain('Idea: escanear / código');
    expect(digest).toContain('rechazada: no hay lectores');
    expect(digest).toContain('issue #812');
    expect(digest).toContain('Seed roto _(entorno de dev)_');
    expect(digest).not.toContain('De un PR anterior');
    expect(digest).toContain('runs/2026-10-14-123.md');
  });

  it('says so when an app has nothing in this PR', () => {
    const digest = renderDigest({
      since: '2026-10-12', branch: 'b', repo: 'o/r',
      apps: [{ appName: 'backoffice', memory: { dir: '', inventory: { funciones: [] }, knowledge: '', findings: [] }, findingIds: new Set(), runs: [] }],
    });
    expect(digest).toContain('Sin propuestas en este PR.');
  });
});

describe('findingsAddedOverBase', () => {
  const dir = 'docs/exploration/backoffice';
  it('leaves out findings an earlier, merged PR already brought, even when this branch updates them (redmotos/shoppingcart#810)', () => {
    const changed = [
      `${dir}/findings/F-0001-agregar-un-producto.md`,
      `${dir}/findings/F-0005-reconteo.md`,
      `${dir}/findings/F-0006-ultimo-grupo.md`,
      `${dir}/inventory.yml`,
      `${dir}/runs/2026-10-13-691034.md`,
    ];
    const base = [`${dir}/findings/F-0001-agregar-un-producto.md`, `${dir}/findings/F-0005-reconteo.md`];
    expect(findingsAddedOverBase(changed, base)).toEqual(new Set(['F-0006']));
  });

  it('matches by id, so an old finding whose file was renamed is still old', () => {
    expect(findingsAddedOverBase([`${dir}/findings/F-0002-titulo-nuevo.md`], [`${dir}/findings/F-0002-titulo-viejo.md`])).toEqual(new Set());
  });
});
