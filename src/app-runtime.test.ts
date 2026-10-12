import { describe, it, expect, vi } from 'vitest';

vi.mock('./config.js', () => ({ config: { worktreeBaseRef: 'origin/main' } }));
vi.mock('./repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', productRepoPath: '/repo', worktreeBasePath: '/wt' }),
}));

import { appProjectName, rewriteComposeConfig } from './app-runtime.js';

const resolved = {
  name: 'app-probe',
  services: {
    web: {
      container_name: 'web',
      image: 'api',
      ports: [{ mode: 'ingress', target: 80, published: '5000', protocol: 'tcp' }],
    },
    postgres: {
      container_name: 'postgres-ecommerce',
      image: 'postgres:16',
      ports: [{ mode: 'ingress', target: 5432, published: '5434', protocol: 'tcp' }],
    },
    worker: { image: 'worker' },
  },
  volumes: { data: { name: 'app-probe_data' } },
};

describe('rewriteComposeConfig', () => {
  it('remaps every published port to a free one on localhost and reports it', async () => {
    let next = 40000;
    const { config, ports } = await rewriteComposeConfig(resolved, async () => next++);
    expect(config.services.web.ports).toEqual([{ mode: 'ingress', target: 80, published: '40000', protocol: 'tcp', host_ip: '127.0.0.1' }]);
    expect(config.services.postgres.ports[0].published).toBe('40001');
    expect(ports).toEqual({ web: { '80': 40000 }, postgres: { '5432': 40001 } });
  });

  it('drops fixed container names and the project name', async () => {
    const { config } = await rewriteComposeConfig(resolved, async () => 1);
    expect(config.services.web.container_name).toBeUndefined();
    expect(config.services.postgres.container_name).toBeUndefined();
    expect(config.name).toBeUndefined();
  });

  it('leaves services without ports and the rest of the file untouched', async () => {
    const { config } = await rewriteComposeConfig(resolved, async () => 1);
    expect(config.services.worker).toEqual({ image: 'worker' });
    expect(config.volumes).toEqual(resolved.volumes);
  });
});

describe('appProjectName', () => {
  it('is stable per repo and app, and a valid compose project name', () => {
    expect(appProjectName('backoffice')).toBe('ronin-app-redmotos-shoppingcart-backoffice');
    expect(appProjectName('Back Office!')).toBe('ronin-app-redmotos-shoppingcart-back-office-');
  });
});
