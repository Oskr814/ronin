import { describe, it, expect, vi } from 'vitest';

vi.mock('../core/config.js', () => ({ config: { githubLogin: 'ronin', worktreeBaseRef: 'origin/main' } }));
vi.mock('../core/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

import { parsePrototypeResult, prototypeBrowsers, renderPrototypeComment, serverName } from './prototype.js';

const OUT = '/tmp/prototype-out/820-1';

describe('serverName', () => {
  it('turns a role into a plain MCP server name', () => {
    expect(serverName('Admin', 'desktop')).toBe('admin-desktop');
    expect(serverName('Bodega Central', 'mobile')).toBe('bodega-central-mobile');
    expect(serverName('Vendedor/Público', 'desktop')).toBe('vendedor-publico-desktop');
  });
});

describe('prototypeBrowsers', () => {
  it('gives one browser per role and viewport, once per role', () => {
    const users = [
      { role: 'Admin', username: 'a', password: 'p', notes: 'todo' },
      { role: 'Sales', username: 's', password: 'p' },
      { role: 'Admin', username: 'a2', password: 'p' },
    ];
    expect(prototypeBrowsers({ users }).map((b) => b.server)).toEqual(['admin-desktop', 'admin-mobile', 'sales-desktop', 'sales-mobile']);
    expect(prototypeBrowsers({ users })[0]).toEqual({ server: 'admin-desktop', role: 'Admin', viewport: 'desktop', notes: 'todo' });
  });
});

describe('parsePrototypeResult', () => {
  it('keeps images inside the run dir, at most three of each', () => {
    const result = parsePrototypeResult(JSON.stringify({
      resumen: 'Guarda los filtros en la URL.',
      antes: [{ imagen: 'admin-desktop/antes-1.png', nota: 'hoy' }, { imagen: '../../.env' }],
      despues: [1, 2, 3, 4].map((n) => ({ imagen: `admin-desktop/despues-${n}.png` })),
    }), OUT);
    expect(result).toEqual({
      resumen: 'Guarda los filtros en la URL.',
      antes: [{ imagen: `${OUT}/admin-desktop/antes-1.png`, nota: 'hoy' }],
      despues: [1, 2, 3].map((n) => ({ imagen: `${OUT}/admin-desktop/despues-${n}.png` })),
    });
  });

  it('passes the agent\'s reason through when it could not make one', () => {
    expect(parsePrototypeResult('{"error": "el issue no dice qué cambiar"}', OUT)).toEqual({ error: 'el issue no dice qué cambiar' });
  });

  it('fails without any after image', () => {
    expect(() => parsePrototypeResult('{"resumen": "x", "despues": [{"imagen": "/etc/passwd"}]}', OUT)).toThrow('después');
  });
});

describe('renderPrototypeComment', () => {
  const result = {
    appName: 'backoffice',
    resumen: 'Guarda búsqueda, estado y página en la URL.',
    antes: [{ url: 'https://x/antes-1.png', nota: 'hoy', viewport: 'desktop' as const }],
    despues: [{ url: 'https://x/despues-1.png', nota: 'con el cambio', viewport: 'mobile' as const }],
    patch: 'diff --git a/x b/x\n+nuevo',
  };

  it('shows each before next to its after, the diff, and says there is no PR', () => {
    const body = renderPrototypeComment(result, 'ronin');
    expect(body.indexOf('**Antes**: hoy')).toBeLessThan(body.indexOf('**Después**: con el cambio'));
    expect(body).toContain('<img src="https://x/despues-1.png" alt="con el cambio" width="320">');
    expect(body).toContain('```diff\ndiff --git a/x b/x\n+nuevo\n```');
    expect(body).toContain('no hay rama ni PR');
  });

  it('cuts a huge diff so the comment stays under GitHub\'s limit', () => {
    const body = renderPrototypeComment({ ...result, patch: 'x'.repeat(100_000) }, 'ronin');
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain('(recortado)');
  });

  it('leaves the diff out when the after is only an HTML drawing', () => {
    expect(renderPrototypeComment({ ...result, patch: '' }, 'ronin')).not.toContain('<details>');
  });
});
