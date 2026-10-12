import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendKnowledge,
  ensureMemoryDir,
  findDuplicate,
  findingFileName,
  loadMemory,
  mergeInventory,
  nextFindingId,
  normalizeHuella,
  parseFinding,
  parseInventory,
  recordCoverage,
  saveInventory,
  serializeFinding,
  serializeInventory,
  slugify,
  writeFinding,
  type Finding,
  type Inventory,
} from './exploration-memory.js';

const inventory: Inventory = {
  actualizado: { fecha: '2026-10-12', sha: 'abc123' },
  funciones: [
    {
      id: 'pedidos.confirmar',
      nombre: 'Confirmar pedido',
      rutas: ['/pedidos/:orderId/confirmar'],
      roles: ['Sales', 'Admin'],
      archivos: ['apps/backoffice/src/modules/pedidos/pages/orders/ConfirmOrderPage.tsx'],
      notas: 'bodega también la usa desde el teléfono',
      prioridad: 'alta',
      cobertura: { desktop: { 'camino-feliz': '2026-10-14' }, mobile: {} },
      hallazgos: ['F-0001'],
    },
  ],
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F-0007',
    tipo: 'hallazgo',
    titulo: 'Doble envío duplica el pedido',
    funcion: 'pedidos.confirmar',
    senal: 'bug',
    gravedad: 'bug',
    charter: 'interrupciones',
    viewport: 'mobile',
    rol: 'Sales',
    semilla: 83121,
    fecha: '2026-10-14',
    estado: 'propuesto',
    huella: 'confirmar|doble-click|pedido-duplicado',
    body: 'Qué pasó y cómo reproducirlo.',
    ...overrides,
  };
}

describe('inventory', () => {
  it('round-trips through YAML, dates kept as strings', () => {
    const parsed = parseInventory(serializeInventory(inventory));
    expect(parsed).toEqual(inventory);
    expect(typeof parsed.funciones[0].cobertura.desktop['camino-feliz']).toBe('string');
  });

  it('tolerates hand edits: unknown priority, bad charter, missing fields', () => {
    const parsed = parseInventory(`
funciones:
  - id: clientes.detalle
    prioridad: urgente
    cobertura:
      desktop: { camino-feliz: 2026-10-01, inventado: 2026-10-02 }
  - nombre: sin id
`);
    expect(parsed.funciones).toEqual([
      {
        id: 'clientes.detalle',
        nombre: 'clientes.detalle',
        rutas: [],
        roles: [],
        archivos: [],
        prioridad: 'normal',
        cobertura: { desktop: { 'camino-feliz': '2026-10-01' }, mobile: {} },
        hallazgos: [],
      },
    ]);
  });

  it('reads an empty file as an empty inventory', () => {
    expect(parseInventory('')).toEqual({ funciones: [] });
  });
});

describe('mergeInventory', () => {
  const discovered = [
    { id: 'pedidos.confirmar', nombre: 'Confirmar pedido', rutas: ['/pedidos/:id/confirmar'], roles: ['Sales'], archivos: ['a.tsx'] },
    { id: 'pedidos.surtir', nombre: 'Surtir pedido', rutas: ['/pedidos/:id/surtir'], roles: ['Sales'], archivos: ['b.tsx'] },
  ];

  it('adds new functions and updates code facts, keeping notes, priority and coverage', () => {
    const { inventory: merged, added, retired } = mergeInventory(inventory, discovered, '2026-10-20', 'def456');
    expect(added).toEqual(['pedidos.surtir']);
    expect(retired).toEqual([]);
    expect(merged.actualizado).toEqual({ fecha: '2026-10-20', sha: 'def456' });
    expect(merged.funciones[0]).toMatchObject({
      rutas: ['/pedidos/:id/confirmar'],
      roles: ['Sales'],
      notas: 'bodega también la usa desde el teléfono',
      prioridad: 'alta',
      cobertura: { desktop: { 'camino-feliz': '2026-10-14' }, mobile: {} },
      hallazgos: ['F-0001'],
    });
    expect(merged.funciones[1]).toEqual({ ...discovered[1], prioridad: 'normal', cobertura: { desktop: {}, mobile: {} }, hallazgos: [] });
  });

  it('retires a function that disappeared, once, and brings it back if it returns', () => {
    const first = mergeInventory(inventory, [discovered[1]], '2026-10-20', 'x');
    expect(first.retired).toEqual(['pedidos.confirmar']);
    expect(first.inventory.funciones[0].retirada).toBe('2026-10-20');

    const second = mergeInventory(first.inventory, [discovered[1]], '2026-10-27', 'y');
    expect(second.retired).toEqual([]);
    expect(second.inventory.funciones[0].retirada).toBe('2026-10-20');

    const back = mergeInventory(second.inventory, discovered, '2026-11-03', 'z');
    expect(back.inventory.funciones[0].retirada).toBeUndefined();
  });
});

describe('recordCoverage', () => {
  it('sets the date per viewport and charter and adds findings once', () => {
    const updated = recordCoverage(
      inventory,
      'pedidos.confirmar',
      [{ viewport: 'mobile', charter: 'interrupciones' }, { viewport: 'desktop', charter: 'camino-feliz' }],
      '2026-10-21',
      ['F-0001', 'F-0007'],
    );
    expect(updated.funciones[0].cobertura).toEqual({ desktop: { 'camino-feliz': '2026-10-21' }, mobile: { interrupciones: '2026-10-21' } });
    expect(updated.funciones[0].hallazgos).toEqual(['F-0001', 'F-0007']);
    expect(inventory.funciones[0].cobertura.mobile).toEqual({});
  });
});

describe('findings', () => {
  it('round-trips a finding, with "señal" as the key in the file', () => {
    const text = serializeFinding(finding({ issue: 812, motivo: 'ya cubierto' }));
    expect(text).toMatch(/^---\nid: F-0007\ntipo: hallazgo\nseñal: bug\n/);
    expect(parseFinding(text)).toEqual(finding({ issue: 812, motivo: 'ya cubierto' }));
  });

  it('rejects a file without frontmatter or without its key fields', () => {
    expect(() => parseFinding('sin frontmatter')).toThrow(/frontmatter/);
    expect(() => parseFinding('---\nid: F-1\n---\n')).toThrow(/funcion/);
  });

  it('numbers new findings after the highest one', () => {
    expect(nextFindingId([])).toBe('F-0001');
    expect(nextFindingId([{ id: 'F-0002' }, { id: 'F-0010' }, { id: 'F-0003' }])).toBe('F-0011');
  });

  it('names the file after the id and a slug of the title', () => {
    expect(findingFileName(finding())).toBe('F-0007-doble-envio-duplica-el-pedido.md');
    expect(slugify('¡Confirmar  pedido / con ñandú!')).toBe('confirmar-pedido-con-nandu');
  });
});

describe('findDuplicate', () => {
  const existing = [
    { id: 'F-0007', funcion: 'pedidos.confirmar', huella: 'confirmar|doble-click|pedido-duplicado' },
    { id: 'F-0009', funcion: 'pedidos.surtir', huella: 'surtir|cantidad-negativa|stock-incorrecto' },
  ];

  it('matches the same huella written differently', () => {
    expect(normalizeHuella('Confirmar | Doble Click | Pedido duplicado')).toEqual(['confirmar', 'doble-click', 'pedido-duplicado']);
    expect(findDuplicate({ funcion: 'pedidos.confirmar', huella: 'Confirmar|DOBLE click|pedido duplicado' }, existing)).toBe('F-0007');
  });

  it('matches enough words in common within the same function', () => {
    expect(findDuplicate({ funcion: 'pedidos.confirmar', huella: 'confirmar|doble-click-boton|pedido-duplicado' }, existing)).toBe('F-0007');
  });

  it('does not match similar words on another function, or a different problem', () => {
    expect(findDuplicate({ funcion: 'pedidos.surtir', huella: 'surtir|doble-click|pedido-duplicado' }, existing)).toBeUndefined();
    expect(findDuplicate({ funcion: 'pedidos.confirmar', huella: 'confirmar|busqueda-lenta|muchos-pasos' }, existing)).toBeUndefined();
  });
});

describe('on disk', () => {
  it('creates the directory once, writes and loads the whole memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ronin-memory-'));
    try {
      await ensureMemoryDir(dir);
      await appendKnowledge(dir, 'La gestión de pedidos en mobile ya está cubierta (2026-10-12).');
      await ensureMemoryDir(dir);
      await saveInventory(dir, inventory);
      await writeFinding(dir, finding());
      const memory = await loadMemory(dir);
      expect(memory.inventory).toEqual(inventory);
      expect(memory.findings).toEqual([(({ body: _, ...meta }) => meta)(finding())]);
      expect(memory.knowledge).toContain('- La gestión de pedidos en mobile ya está cubierta');
      expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('Exploración de ronin');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads an empty memory from a directory that does not exist yet', async () => {
    const memory = await loadMemory(join(tmpdir(), 'ronin-memory-missing'));
    expect(memory).toMatchObject({ inventory: { funciones: [] }, findings: [], knowledge: '' });
  });
});
