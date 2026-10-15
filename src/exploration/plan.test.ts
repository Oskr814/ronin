import { describe, it, expect } from 'vitest';
import { parseDiscoveredFunctions, pickCharter, planRun, seededRandom } from './plan.js';
import { CHARTERS, type InventoryFunction } from './memory.js';

function fn(id: string, overrides: Partial<InventoryFunction> = {}): InventoryFunction {
  return {
    id,
    nombre: id,
    rutas: [`/${id}`],
    roles: ['Sales'],
    archivos: [`${id}.tsx`],
    prioridad: 'normal',
    cobertura: { desktop: {}, mobile: {} },
    hallazgos: [],
    ...overrides,
  };
}

const explored = (date: string) => ({ desktop: { 'camino-feliz': date }, mobile: {} });

describe('seededRandom', () => {
  it('draws the same sequence for the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(seededRandom(43)()).not.toBe(seededRandom(42)());
  });
});

describe('pickCharter', () => {
  it('only draws charters never applied to the function', () => {
    const f = fn('a', { cobertura: { desktop: { 'camino-feliz': '2026-10-01' }, mobile: { 'datos-hostiles': '2026-10-02' } } });
    for (let seed = 0; seed < 50; seed++) {
      expect(['camino-feliz', 'datos-hostiles']).not.toContain(pickCharter(f, seededRandom(seed)));
    }
  });

  it('once all are used, picks the one applied longest ago', () => {
    const desktop = Object.fromEntries(CHARTERS.map((c) => [c, '2026-10-10']));
    desktop.volumen = '2026-09-01';
    expect(pickCharter(fn('a', { cobertura: { desktop, mobile: {} } }), seededRandom(1))).toBe('volumen');
  });
});

describe('planRun', () => {
  const base = { changed: new Set<string>(), risk: {}, roles: ['Sales', 'Admin'], seed: 7 };

  it('is deterministic for a seed', () => {
    const inventory = { funciones: ['a', 'b', 'c', 'd', 'e'].map((id) => fn(id)) };
    expect(planRun({ ...base, inventory, maxFunctions: 3 })).toEqual(planRun({ ...base, inventory, maxFunctions: 3 }));
  });

  it('goes new → changed → high priority → oldest, and fills the last slot at random', () => {
    const inventory = {
      funciones: [
        fn('vieja', { cobertura: explored('2026-08-01') }),
        fn('reciente', { cobertura: explored('2026-10-10') }),
        fn('alta', { prioridad: 'alta', cobertura: explored('2026-10-11') }),
        fn('cambiada', { cobertura: explored('2026-10-11') }),
        fn('nueva'),
      ],
    };
    const plan = planRun({ ...base, inventory, changed: new Set(['cambiada']), maxFunctions: 5 });
    expect(plan.functions.map((p) => [p.functionId, p.reason])).toEqual([
      ['nueva', 'nueva'],
      ['cambiada', 'cambiada'],
      ['alta', 'prioritaria'],
      ['vieja', 'antigua'],
      ['reciente', 'azar'],
    ]);
  });

  it('never plans a retired or excluded function', () => {
    const inventory = { funciones: [fn('a', { retirada: '2026-10-01' }), fn('b', { prioridad: 'excluida' }), fn('c')] };
    expect(planRun({ ...base, inventory, maxFunctions: 3 }).functions.map((p) => p.functionId)).toEqual(['c']);
  });

  it('leans the random slot towards risky functions', () => {
    const inventory = { funciones: [fn('nueva'), fn('segura', { cobertura: explored('2026-10-01') }), fn('riesgosa', { cobertura: explored('2026-10-01') })] };
    let risky = 0;
    for (let seed = 0; seed < 200; seed++) {
      const plan = planRun({ ...base, inventory, risk: { riesgosa: 9 }, maxFunctions: 2, seed });
      if (plan.functions[1].functionId === 'riesgosa') risky++;
    }
    expect(risky).toBeGreaterThan(150);
  });

  it('explores as one of the function roles the manifest can log in as', () => {
    const inventory = { funciones: [fn('a', { roles: ['Admin', 'Bodega'] }), fn('b', { roles: ['Desconocido'] })] };
    const plan = planRun({ ...base, inventory, maxFunctions: 2 });
    expect(plan.functions.find((p) => p.functionId === 'a')!.role).toBe('Admin');
    expect(['Sales', 'Admin']).toContain(plan.functions.find((p) => p.functionId === 'b')!.role);
  });

  it('with a single slot, takes it by priority', () => {
    const inventory = { funciones: [fn('vieja', { cobertura: explored('2026-08-01') }), fn('nueva')] };
    expect(planRun({ ...base, inventory, maxFunctions: 1 }).functions.map((p) => p.reason)).toEqual(['nueva']);
  });
});

describe('parseDiscoveredFunctions', () => {
  it('normalizes ids and drops invalid or repeated entries', () => {
    const { functions, dropped } = parseDiscoveredFunctions(JSON.stringify({
      functions: [
        { id: 'Pedidos.Confirmar Pedido', nombre: 'Confirmar pedido', rutas: ['/pedidos/:id/confirmar'], roles: ['Sales'], archivos: ['a.tsx'] },
        { id: 'pedidos.confirmar-pedido', nombre: 'Otra', rutas: ['/x'] },
        { id: 'sin-rutas', nombre: 'Sin rutas', rutas: [] },
        { nombre: 'Sin id', rutas: ['/y'] },
      ],
    }));
    expect(functions).toEqual([
      { id: 'pedidos.confirmar-pedido', nombre: 'Confirmar pedido', rutas: ['/pedidos/:id/confirmar'], roles: ['Sales'], archivos: ['a.tsx'] },
    ]);
    expect(dropped).toHaveLength(3);
  });

  it('accepts a bare list and rejects anything else', () => {
    expect(parseDiscoveredFunctions('[{"id":"a.b","nombre":"A","rutas":["/a"]}]').functions).toHaveLength(1);
    expect(() => parseDiscoveredFunctions('{"x":1}')).toThrow(/lista de funciones/);
  });
});
