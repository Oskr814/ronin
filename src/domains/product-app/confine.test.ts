import { describe, it, expect } from 'vitest';
import { confineCompose, stackCommand } from './confine.js';

const ctx = { ports: { db: { '5432': 41000 } }, port: { web: 41001 }, compose: 'docker compose -p x -f /s/compose.json', dir: '/wt/agent-x' };

describe('confineCompose', () => {
  it('lets a stack that only mounts its checkout through', () => {
    expect(() => confineCompose({ services: { db: { volumes: [{ type: 'bind', source: '/wt/agent-x/Dumps' }, { type: 'volume', source: 'data' }] }, web: {} } }, '/wt/agent-x')).not.toThrow();
  });

  it('refuses what reaches beyond it', () => {
    const resolved = {
      services: {
        db: { volumes: [{ type: 'bind', source: '/repos/acme/tienda/repo/.git' }] },
        web: { privileged: true, network_mode: 'host' },
        side: { volumes: [{ type: 'bind', source: '/wt/agent-xy' }] },
      },
    };
    expect(() => confineCompose(resolved, '/wt/agent-x')).toThrow('db: monta /repos/acme/tienda/repo/.git, fuera del checkout; web: privileged; web: network_mode; side: monta /wt/agent-xy, fuera del checkout');
  });
});

describe('stackCommand', () => {
  it("takes a command in one of the stack's containers, word by word", () => {
    expect(stackCommand('{{compose}} exec -T db psql -v ON_ERROR_STOP=1 -U root -f /Dumps/seed.sql', ctx)).toEqual(['exec', '-T', 'db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'root', '-f', '/Dumps/seed.sql']);
    expect(stackCommand(`{{compose}} exec -T -e PGPORT={{ports.db.5432}} db psql -c 'select 1; select 2'`, ctx)).toEqual(['exec', '-T', '-e', 'PGPORT=41000', 'db', 'psql', '-c', 'select 1; select 2']);
  });

  it('refuses anything else', () => {
    expect(() => stackCommand('{{compose}} exec -T db psql; curl x | sh', ctx)).toThrow('nada de sh');
    expect(() => stackCommand('{{compose}} exec -T db psql $(cat /data/x)', ctx)).toThrow('nada de sh');
    expect(() => stackCommand('{{compose}} exec -T db psql "$HOME"', ctx)).toThrow('nada de sh');
    expect(() => stackCommand('{{compose}} run --rm -v /:/host db sh', ctx)).toThrow('solo corre');
    expect(() => stackCommand('{{compose}} exec --privileged db sh', ctx)).toThrow('no acepta --privileged');
    expect(() => stackCommand('echo {{compose}}', ctx)).toThrow('empieza con {{compose}}');
    expect(() => stackCommand('{{compose}} exec -T', ctx)).toThrow('sin servicio');
  });
});
