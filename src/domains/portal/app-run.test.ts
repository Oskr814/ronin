import { describe, it, expect, vi } from 'vitest';

vi.mock('@platform/config/config.js', () => ({ config: { githubLogin: 'ronin', worktreeBaseRef: 'origin/main' } }));
vi.mock('@platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, draftDiff, parsePrototypeResult, prototypeBrowsers, serverName } from './app-run.js';

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

describe('draftDiff', () => {
  it("leaves out what the app's startup had already changed, keeping the draft and its new files", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ronin-draft-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
    git('init', '-q');
    writeFileSync(join(dir, 'api.xml'), '<doc/>\n');
    writeFileSync(join(dir, 'Orders Page.tsx'), 'total\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    writeFileSync(join(dir, 'api.xml'), '<doc>generado</doc>\n');
    writeFileSync(join(dir, 'build.log'), 'x\n');
    const generated = await changedFiles(dir);
    expect(generated.sort()).toEqual(['api.xml', 'build.log']);
    writeFileSync(join(dir, 'Orders Page.tsx'), 'total en negrita\n');
    writeFileSync(join(dir, 'nuevo.ts'), 'export {};\n');
    const patch = await draftDiff(dir, generated);
    expect(patch).toContain('+total en negrita');
    expect(patch).toContain('nuevo.ts');
    expect(patch).not.toMatch(/api\.xml|build\.log/);
  });

  it('copes with a startup that leaves thousands of files, more than fit in argv', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ronin-draft-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
    git('init', '-q');
    writeFileSync(join(dir, 'page.tsx'), 'total\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const out = join(dir, 'bin', 'Debug', 'net8.0', 'una-carpeta-de-salida-con-un-nombre-bastante-largo'.repeat(2));
    mkdirSync(out, { recursive: true });
    for (let i = 0; i < 15_000; i++) writeFileSync(join(out, `Ensamblado.Generado.Numero${i}.dll.config`), 'x\n');
    const generated = await changedFiles(dir);
    expect(generated.length).toBe(15_000);
    writeFileSync(join(dir, 'page.tsx'), 'total en negrita\n');
    const patch = await draftDiff(dir, generated);
    expect(patch).toContain('+total en negrita');
    expect(patch).not.toContain('Ensamblado');
  }, 60_000);
});
