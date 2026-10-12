import { describe, it, expect, vi } from 'vitest';

vi.mock('./config.js', () => ({ config: { worktreeBaseRef: 'origin/main', githubLogin: 'ronin-agent' } }));
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', worktreeBaseRef: 'origin/odoo-main' }) }));
vi.mock('./github.js', () => ({}));

import { explorationBranch, findingIssueKey, isoWeek, renderDigest, renderFindingIssue, weekOfBranch } from './exploration-pr.js';
import type { Finding, FindingMeta } from './exploration-memory.js';

function meta(overrides: Partial<FindingMeta> = {}): FindingMeta {
  return {
    id: 'F-0007', tipo: 'hallazgo', titulo: 'Doble toque duplica el pedido', funcion: 'pedidos.confirmar', senal: 'bug', gravedad: 'bug',
    charter: 'interrupciones', viewport: 'mobile', rol: 'Sales', semilla: 83121, fecha: '2026-10-14', estado: 'propuesto',
    huella: 'pedidos.confirmar|doble-toque|duplicado', ...overrides,
  };
}

describe('isoWeek', () => {
  it('follows ISO 8601: weeks start on Monday and belong to their Thursday’s year', () => {
    expect(isoWeek(new Date('2026-10-12T03:00:00'))).toBe('2026-W42');
    expect(isoWeek(new Date('2026-10-18T23:00:00'))).toBe('2026-W42');
    expect(isoWeek(new Date('2026-10-19T00:30:00'))).toBe('2026-W43');
    expect(isoWeek(new Date('2027-01-01T12:00:00'))).toBe('2026-W53');
    expect(isoWeek(new Date('2025-12-29T12:00:00'))).toBe('2026-W01');
  });

  it('names the branch after the week and reads it back', () => {
    expect(explorationBranch('2026-W42')).toBe('ronin/exploration/2026-W42');
    expect(weekOfBranch('ronin/exploration/2026-W42')).toBe('2026-W42');
    expect(weekOfBranch('ronin/42/slice-1')).toBeUndefined();
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
  it('lists this week’s findings per app with their state, and how to review', () => {
    const memory = {
      dir: '/m',
      inventory: { funciones: [] },
      knowledge: '',
      findings: [
        meta(),
        meta({ id: 'F-0008', titulo: 'Idea: escanear | código', tipo: 'idea', gravedad: 'pulido', estado: 'rechazado', motivo: 'no hay lectores' }),
        meta({ id: 'F-0009', titulo: 'Con issue', issue: 812 }),
        meta({ id: 'F-0001', titulo: 'De otra semana', fecha: '2026-10-01' }),
      ],
    };
    const digest = renderDigest({
      week: '2026-W42', branch: 'ronin/exploration/2026-W42', repo: 'o/r', login: 'ronin-agent',
      apps: [{ appName: 'backoffice', memory, runs: ['2026-10-14-123'] }],
    });
    expect(digest).toContain('# Exploración de ronin — semana 2026-W42');
    expect(digest).toContain('comentá en su ficha');
    expect(digest).toContain('[F-0007](https://github.com/o/r/blob/ronin/exploration/2026-W42/docs/exploration/backoffice/findings/F-0007-doble-toque-duplica-el-pedido.md)');
    expect(digest).toContain('Idea: escanear / código');
    expect(digest).toContain('rechazada: no hay lectores');
    expect(digest).toContain('issue #812');
    expect(digest).not.toContain('De otra semana');
    expect(digest).toContain('runs/2026-10-14-123.md');
  });

  it('says so when an app has nothing this week', () => {
    const digest = renderDigest({
      week: '2026-W42', branch: 'b', repo: 'o/r', login: 'x',
      apps: [{ appName: 'backoffice', memory: { dir: '', inventory: { funciones: [] }, knowledge: '', findings: [] }, runs: [] }],
    });
    expect(digest).toContain('Sin propuestas esta semana.');
  });
});
