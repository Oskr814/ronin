import { describe, it, expect } from 'vitest';
import { DEFAULT_VIEWPORTS, namedPortsIn, parseAppManifest, publicizeTemplate, publicPortsIn, renderTemplate, stepsToRerun, type AppStep } from './manifest.js';

function manifest(app: Record<string, unknown> = {}) {
  return JSON.stringify({
    apps: {
      backoffice: {
        path: 'apps/backoffice',
        compose: { files: ['docker-compose.dev.yml'] },
        steps: [{ compose: 'up' }, { name: 'web', start: 'vite --port {{port.web}}' }],
        baseUrl: 'http://127.0.0.1:{{port.web}}',
        users: [{ role: 'Sales', username: 'sales@x', password: 'password' }],
        login: [{ goto: '/login' }, { fill: '#username', value: '{{username}}' }, { click: 'button[type=submit]' }],
        ...app,
      },
    },
  });
}

describe('parseAppManifest', () => {
  it('parses a complete app and fills default viewports', () => {
    const { apps } = parseAppManifest(manifest());
    expect(apps.backoffice.path).toBe('apps/backoffice');
    expect(apps.backoffice.steps).toEqual([{ compose: 'up' }, { start: 'vite --port {{port.web}}', name: 'web', cwd: undefined, env: undefined }]);
    expect(apps.backoffice.viewports).toEqual(DEFAULT_VIEWPORTS);
    expect(apps.backoffice.login[1]).toEqual({ fill: '#username', value: '{{username}}' });
  });

  it('merges a partial viewport over the default', () => {
    const { apps } = parseAppManifest(manifest({ viewports: { mobile: { width: 375 } } }));
    expect(apps.backoffice.viewports.mobile).toEqual({ width: 375, height: 844, isMobile: true });
  });

  it('rejects a compose step without compose files', () => {
    expect(() => parseAppManifest(manifest({ compose: undefined }))).toThrow(/falta compose.files/);
  });

  it('rejects an unknown step', () => {
    expect(() => parseAppManifest(manifest({ steps: [{ deploy: 'prod' }] }))).toThrow(/no es un paso conocido/);
  });

  it('rejects two start steps with the same name', () => {
    const steps = [{ name: 'web', start: 'a' }, { name: 'web', start: 'b' }];
    expect(() => parseAppManifest(manifest({ steps }))).toThrow(/mismo name/);
  });

  it('rejects an app without users', () => {
    expect(() => parseAppManifest(manifest({ users: [] }))).toThrow(/users/);
  });

  it('rejects a manifest with no apps', () => {
    expect(() => parseAppManifest('{"apps":{}}')).toThrow(/al menos una app/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseAppManifest('{')).toThrow(/no es JSON válido/);
  });

  it('keeps the rerunOn globs of every kind of step', () => {
    const steps = [
      { compose: 'up', rerunOn: ['apps/api/**'] },
      { name: 'deps', run: 'pnpm install', rerunOn: ['pnpm-lock.yaml', '**/package.json'] },
      { name: 'api', start: 'pnpm start', rerunOn: ['packages/types/**'] },
      { wait: 'http://127.0.0.1:{{port.api}}/health', rerunOn: ['packages/types/**'] },
    ];
    const parsed = parseAppManifest(manifest({ steps })).apps.backoffice.steps;
    expect(parsed.map((s) => s.rerunOn)).toEqual([['apps/api/**'], ['pnpm-lock.yaml', '**/package.json'], ['packages/types/**'], ['packages/types/**']]);
  });

  it('leaves rerunOn out of a step that does not declare it', () => {
    expect(parseAppManifest(manifest()).apps.backoffice.steps[0]).toStrictEqual({ compose: 'up' });
  });

  it('rejects a rerunOn that is not a non-empty list of globs', () => {
    expect(() => parseAppManifest(manifest({ steps: [{ run: 'x', rerunOn: [] }] }))).toThrow(/steps\[0\]\.rerunOn debe ser una lista no vacía/);
    expect(() => parseAppManifest(manifest({ steps: [{ run: 'x', rerunOn: 'pnpm-lock.yaml' }] }))).toThrow(/rerunOn debe ser una lista/);
    expect(() => parseAppManifest(manifest({ steps: [{ run: 'x', rerunOn: [''] }] }))).toThrow(/rerunOn\[0\] falta/);
  });
});

describe('stepsToRerun', () => {
  const install: AppStep = { name: 'deps', run: 'pnpm install', rerunOn: ['pnpm-lock.yaml'] };
  const migrate: AppStep = { name: 'migraciones', run: 'pnpm migrate', rerunOn: ['apps/api/src/migrations/**'] };
  const api: AppStep = { name: 'api', start: 'pnpm start', rerunOn: ['pnpm-lock.yaml', 'packages/types/**'] };
  const web: AppStep = { name: 'web', start: 'vite' };

  it('picks, in order, the steps whose globs match a changed file', () => {
    const app = { steps: [install, migrate, api, web] };
    expect(stepsToRerun(app, ['pnpm-lock.yaml', 'apps/web/src/a.tsx'])).toEqual([install, api]);
    expect(stepsToRerun(app, ['apps/api/src/migrations/1700-add-x.ts'])).toEqual([migrate]);
  });

  it('runs nothing when only code the dev servers reload changed', () => {
    expect(stepsToRerun({ steps: [install, migrate, api, web] }, ['apps/web/src/a.tsx'])).toEqual([]);
  });

  it('is null for a manifest where no step declares rerunOn', () => {
    expect(stepsToRerun({ steps: [{ compose: 'up' }, web] }, ['pnpm-lock.yaml'])).toBeNull();
  });
});

describe('renderTemplate', () => {
  const ctx = { ports: { web: { '80': 41234 } }, port: { backoffice: 5173 }, compose: 'docker compose -p p -f f.json', dir: '/w' };

  it('renders every kind of variable', () => {
    expect(renderTemplate('http://127.0.0.1:{{ports.web.80}} {{ port.backoffice }} {{compose}} {{dir}}', ctx))
      .toBe('http://127.0.0.1:41234 5173 docker compose -p p -f f.json /w');
  });

  it('throws on an unknown variable instead of leaving it in place', () => {
    expect(() => renderTemplate('{{ports.api.80}}', ctx)).toThrow(/ports.api.80/);
    expect(() => renderTemplate('{{secret}}', ctx)).toThrow(/secret/);
    expect(() => renderTemplate('{{public.ports.api.80}}', ctx)).toThrow(/public.ports.api.80/);
  });

  it('renders public URLs on loopback when there is no public host', () => {
    expect(renderTemplate('{{public.ports.web.80}} {{public.port.backoffice}} {{publicHost}}', ctx))
      .toBe('http://127.0.0.1:41234 http://127.0.0.1:5173 127.0.0.1');
  });

  it('renders the port a local one is published on, when it has one', () => {
    expect(renderTemplate('{{public.ports.web.80}} {{public.port.backoffice}}', { ...ctx, publicHost: 'h.ts.net', publicPorts: { '41234': 20001 } }))
      .toBe('https://h.ts.net:20001 https://h.ts.net:5173');
  });

  it('renders public URLs over HTTPS on the public host when there is one', () => {
    expect(renderTemplate('{{public.ports.web.80}} {{public.port.backoffice}} {{publicHost}}', { ...ctx, publicHost: 'runner.tail.ts.net' }))
      .toBe('https://runner.tail.ts.net:41234 https://runner.tail.ts.net:5173 runner.tail.ts.net');
  });
});

describe('publicizeTemplate', () => {
  it('turns loopback URLs to the app ports into public ones', () => {
    expect(publicizeTemplate('http://127.0.0.1:{{ports.web.80}}/api')).toBe('{{public.ports.web.80}}/api');
    expect(publicizeTemplate('http://localhost:{{ port.api }}')).toBe('{{public.port.api}}');
  });

  it('leaves everything else alone', () => {
    expect(publicizeTemplate('postgres://root@127.0.0.1:{{ports.db.5432}}/x')).toBe('postgres://root@127.0.0.1:{{ports.db.5432}}/x');
    expect(publicizeTemplate('http://127.0.0.1:5000')).toBe('http://127.0.0.1:5000');
    expect(publicizeTemplate('{{public.ports.web.80}}')).toBe('{{public.ports.web.80}}');
  });
});

describe('publicPortsIn', () => {
  it('lists the ports a template exposes through public variables only', () => {
    const ctx = { ports: { web: { '80': 41234 } }, port: { backoffice: 5173, admin: 6000 }, compose: '', dir: '/w' };
    expect(publicPortsIn('{{public.ports.web.80}} {{port.admin}} {{public.port.backoffice}} {{ports.web.80}}', ctx)).toEqual([41234, 5173]);
  });
});

describe('namedPortsIn', () => {
  it('lists only the named ports a template references', () => {
    expect(namedPortsIn('{{port.web}} {{ports.api.80}} {{port.admin}} {{dir}}')).toEqual(['web', 'admin']);
    expect(namedPortsIn('{{public.port.web}} {{public.ports.api.80}}')).toEqual(['web']);
  });
});
