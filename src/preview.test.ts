import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('./config.js', () => ({ config: { githubLogin: 'ronin-agent' } }));

import { previewPorts, previewPrFromDirName, renderPreviewFailed, renderPreviewReady } from './preview.js';
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

describe('renderPreviewFailed', () => {
  it('puts the first line inline and the log tail in a collapsed block', () => {
    const body = renderPreviewFailed('backoffice', new Error('"pnpm install" salió con código 1\nERR_PNPM_X\nmore'));
    expect(body).toContain('No pude levantar `backoffice`: "pnpm install" salió con código 1');
    expect(body).toContain('<details>');
    expect(body).toContain('ERR_PNPM_X\nmore');
  });

  it('skips the block when there is no detail', () => {
    expect(renderPreviewFailed(undefined, new Error('no hay tailscale'))).not.toContain('<details>');
  });
});
