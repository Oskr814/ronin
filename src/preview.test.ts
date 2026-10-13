import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('./config.js', () => ({ config: { githubLogin: 'ronin-agent' } }));

import { parsePreviewData, previewPorts, previewPrFromDirName, renderPreviewFailed, renderPreviewReady, resolvePreviewArgs } from './preview.js';
import type { AppDefinition, TemplateContext } from './app-manifest.js';

const app = {
  steps: [
    { compose: 'up' },
    { run: 'psql -p {{ports.postgres.5432}}' },
    { wait: 'http://127.0.0.1:{{ports.web.80}}/swagger' },
    { start: 'vite --port {{port.backoffice}}', name: 'backoffice', env: { VITE_API_URL: '{{public.ports.web.80}}' } },
  ],
} as unknown as AppDefinition;

const ctx: TemplateContext = {
  ports: { web: { '80': 41234 }, postgres: { '5432': 41235 } },
  port: { backoffice: 5173 },
  compose: '',
  dir: '/w',
  publicHost: 'runner.tail.ts.net',
};

describe('previewPorts', () => {
  it('publishes the page first, then only what the manifest marks as public', () => {
    expect(previewPorts({ app, ctx, baseUrl: 'http://127.0.0.1:5173' })).toEqual([5173, 41234]);
  });

  it('also publishes a loopback URL a start step hands to the browser, with no public marker', () => {
    const loopback = {
      steps: [
        { run: 'curl http://127.0.0.1:{{ports.postgres.5432}}' },
        { start: 'vite', name: 'backoffice', env: { VITE_API_URL: 'http://127.0.0.1:{{ports.web.80}}' } },
      ],
    } as unknown as AppDefinition;
    expect(previewPorts({ app: loopback, ctx, baseUrl: 'http://127.0.0.1:5173' })).toEqual([5173, 41234]);
  });

  it('does not list the page twice when it is also marked public', () => {
    const both = { ...app, steps: [{ start: 'x', name: 'x', env: { SELF: '{{public.port.backoffice}}' } }] } as unknown as AppDefinition;
    expect(previewPorts({ app: both, ctx, baseUrl: 'http://127.0.0.1:5173' })).toEqual([5173]);
  });

  it('refuses a baseUrl without an explicit port', () => {
    expect(() => previewPorts({ app, ctx, baseUrl: 'http://127.0.0.1' })).toThrow(/puerto explícito/);
  });
});

describe('previewPrFromDirName', () => {
  it('reads only preview worktree directories', () => {
    expect(previewPrFromDirName('preview-pr-818')).toBe(818);
    expect(previewPrFromDirName('ronin-818-slice-1')).toBeNull();
    expect(previewPrFromDirName('app-backoffice')).toBeNull();
    expect(previewPrFromDirName('preview-pr-818-old')).toBeNull();
  });
});

describe('renderPreviewReady', () => {
  it('gives the URL, the commit, every user, and how to take it down', () => {
    const body = renderPreviewReady({
      appName: 'backoffice',
      sha: 'abcdef1234567',
      url: 'https://runner.tail.ts.net:5173',
      users: [{ role: 'Admin', username: 'admin@x.com', password: 'password' }],
    }, 'ronin-agent');
    expect(body).toContain('**https://runner.tail.ts.net:5173**');
    expect(body).toContain('`abcdef1`');
    expect(body).toContain('| Admin | `admin@x.com` | `password` |');
    expect(body).toContain('`@ronin-agent /preview stop`');
  });
});

describe('renderPreviewReady with prepared data', () => {
  const base = { appName: 'backoffice', sha: 'abcdef1234567', url: 'https://h:1', users: [] };

  it('lists what was prepared and what was not', () => {
    const body = renderPreviewReady({ ...base, data: { preparado: ['Cliente Default Dev (/clientes/15) con 30 catálogos, 4 vencidos'], noPreparado: ['Un catálogo sin productos: la API no lo permite'] } }, 'ronin-agent');
    expect(body).toContain('**Datos listos para probar el PR**\n- Cliente Default Dev (/clientes/15) con 30 catálogos, 4 vencidos');
    expect(body).toContain('**Lo que no pude preparar**\n- Un catálogo sin productos: la API no lo permite');
  });

  it('says when nothing was needed, and when the preparation failed', () => {
    expect(renderPreviewReady({ ...base, data: { preparado: [], noPreparado: [] } }, 'r')).toContain('No hizo falta preparar datos');
    expect(renderPreviewReady({ ...base, data: { error: 'timed out' } }, 'r')).toContain('No pude preparar los datos para probar el PR (timed out)');
  });

  it('says nothing about data when it was not attempted', () => {
    expect(renderPreviewReady(base, 'r')).not.toMatch(/datos/i);
  });
});

describe('parsePreviewData', () => {
  it('keeps only non-empty strings and tolerates missing fields', () => {
    expect(parsePreviewData('{"preparado": ["a", "", 3, " b "]}')).toEqual({ preparado: ['a', 'b'], noPreparado: [] });
  });
});

describe('resolvePreviewArgs', () => {
  it('uses the only app when nothing is said', () => {
    expect(resolvePreviewArgs(undefined, ['backoffice'])).toEqual({ appName: 'backoffice' });
  });

  it('takes the first word as the app only when the manifest has it', () => {
    expect(resolvePreviewArgs('Backoffice', ['backoffice', 'web'])).toEqual({ appName: 'backoffice' });
    expect(resolvePreviewArgs('web un cliente con 40 catálogos', ['backoffice', 'web'])).toEqual({ appName: 'web', instruction: 'un cliente con 40 catálogos' });
  });

  it('treats everything as the instruction when the first word is not an app', () => {
    expect(resolvePreviewArgs('un cliente\ncon 40 catálogos', ['backoffice'])).toEqual({ appName: 'backoffice', instruction: 'un cliente\ncon 40 catálogos' });
  });

  it('asks for the app when there are several and none was named', () => {
    expect(() => resolvePreviewArgs('un cliente', ['backoffice', 'web'])).toThrow(/backoffice, web/);
  });
});

describe('renderPreviewFailed', () => {
  it('puts the first line inline and the log tail in a collapsed block', () => {
    const body = renderPreviewFailed(new Error('"pnpm install" salió con código 1\nERR_PNPM_X\nmore'));
    expect(body).toContain('No pude levantar la app: "pnpm install" salió con código 1');
    expect(body).toContain('<details>');
    expect(body).toContain('ERR_PNPM_X\nmore');
  });

  it('skips the block when there is no detail', () => {
    expect(renderPreviewFailed(new Error('no hay tailscale'))).not.toContain('<details>');
  });
});
