import { describe, it, expect } from 'vitest';
import { hasFocus, parseDiscoveredFunctions, parseFocusPlan, pickCharter, planChosen, planRun, seededRandom } from './plan.js';
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

describe('planChosen', () => {
  it('plans the functions picked by hand, in their order, skipping unknown or retired ones', () => {
    const inventory = { funciones: [fn('a'), fn('b'), fn('c', { retirada: '2026-10-01' })] };
    const plan = planChosen({ inventory, functions: ['b', 'zz', 'c', 'a', 'b'], roles: ['Sales'], seed: 7 });
    expect(plan.functions.map((p) => [p.functionId, p.reason, p.role])).toEqual([['b', 'elegida', 'Sales'], ['a', 'elegida', 'Sales']]);
    expect(plan.functions.every((p) => (CHARTERS as readonly string[]).includes(p.charter))).toBe(true);
  });
});

describe('parseFocusPlan', () => {
  const inventory = { funciones: [fn('citas.crear', { roles: ['Doctor', 'Admin'] }), fn('citas.ver'), fn('viejo', { retirada: '2026-10-01' })] };
  const base = { inventory, pool: ['citas.crear', 'citas.ver'], allowNew: true, roles: ['Doctor', 'Admin', 'Sales'], max: 2, seed: 3 };

  it('takes the functions of the pool with their charter, role and what to look at', () => {
    const raw = JSON.stringify({ funciones: [{ id: 'citas.crear', charter: 'cambio-de-dispositivo', rol: 'Admin', encargo: 'Compactar cada campo en mobile' }] });
    const { plan, added, dropped } = parseFocusPlan(raw, base);
    expect(plan.functions).toEqual([{ functionId: 'citas.crear', charter: 'cambio-de-dispositivo', role: 'Admin', reason: 'foco', encargo: 'Compactar cada campo en mobile' }]);
    expect(added).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('fixes an unknown charter or role, and drops what has no encargo, repeats or goes past the cap', () => {
    const raw = JSON.stringify({ funciones: [
      { id: 'citas.crear', charter: 'inventado', rol: 'Nadie', encargo: 'x' },
      { id: 'citas.crear', encargo: 'otra vez' },
      { id: 'citas.ver' },
      { id: 'citas.ver', encargo: 'y' },
      { id: 'citas.ver', encargo: 'z' },
    ] });
    const { plan, dropped } = parseFocusPlan(raw, base);
    expect(plan.functions.map((p) => p.functionId)).toEqual(['citas.crear', 'citas.ver']);
    expect((CHARTERS as readonly string[]).includes(plan.functions[0].charter)).toBe(true);
    expect(['Doctor', 'Admin']).toContain(plan.functions[0].role);
    expect(dropped).toHaveLength(3);
  });

  it('adds a function the inventory lacks only when the choice was the whole app’s', () => {
    const raw = JSON.stringify({ funciones: [{ id: 'Signos.Vitales', nombre: 'Registrar signos vitales', rutas: ['/atencion/:id'], roles: ['Doctor'], archivos: ['src/a.tsx'], encargo: 'Revisar el alto de cada signo' }] });
    const open = parseFocusPlan(raw, base);
    expect(open.added).toEqual([{ id: 'signos.vitales', nombre: 'Registrar signos vitales', rutas: ['/atencion/:id'], roles: ['Doctor'], archivos: ['src/a.tsx'] }]);
    expect(open.plan.functions[0]).toMatchObject({ functionId: 'signos.vitales', role: 'Doctor', reason: 'foco' });
    const narrowed = parseFocusPlan(raw, { ...base, allowNew: false });
    expect(narrowed.plan.functions).toEqual([]);
    expect(narrowed.added).toEqual([]);
  });

  it('never revives a retired function, nor one outside the functions picked', () => {
    const raw = JSON.stringify({ funciones: [{ id: 'viejo', nombre: 'Viejo', rutas: ['/v'], encargo: 'x' }, { id: 'citas.ver', encargo: 'y' }] });
    expect(parseFocusPlan(raw, { ...base, pool: ['citas.crear'] }).plan.functions).toEqual([]);
  });

  it('says why when nothing fits, and rejects anything but a list', () => {
    expect(parseFocusPlan(JSON.stringify({ funciones: [], motivo: 'Es de otra app' }), base)).toMatchObject({ plan: { functions: [] }, motivo: 'Es de otra app' });
    expect(() => parseFocusPlan('{}', base)).toThrow('lista de funciones');
  });
});

describe('hasFocus', () => {
  it('is a focus only with functions or words', () => {
    expect(hasFocus(undefined)).toBe(false);
    expect(hasFocus({ issue: 3 })).toBe(false);
    expect(hasFocus({ text: '  ' })).toBe(false);
    expect(hasFocus({ functions: ['a'] })).toBe(true);
    expect(hasFocus({ text: 'los formularios' })).toBe(true);
  });
});
