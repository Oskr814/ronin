import { describe, it, expect } from 'vitest';
import { parseProposals, proposalCount, type ProposalContext } from './proposals.js';

const CTX: ProposalContext = {
  lines: 12,
  openIssues: new Map([[915, "Buscar 'nanez' sin tilde no encuentra clientes"], [923, 'Proxy de Cloudflare para el storefront']]),
  linear: { projects: ['Acción para que los usuarios puedan solicitar aviso de existencias', 'Seguridad carrito de compras'], people: ['Abdias V.', 'Oscar Alvarez'] },
};

const issue = (titulo: string, extra: Record<string, unknown> = {}) => ({ titulo, descripcion: `## Qué\n${titulo}`, por_que: 'No hay issue parecido.', citas: [2], ...extra });
const parse = (r: unknown, ctx = CTX) => parseProposals(JSON.stringify(r), ctx);

describe('parseProposals', () => {
  it('takes what holds against the notes, the issues and Linear', () => {
    const out = parse({
      resumen: 'Se habló de devoluciones y de un reporte para bodega.',
      proyectos: [{ nombre: 'Devoluciones de pedidos mayoristas', descripcion: 'Registrar devoluciones.', por_que: 'Ningún proyecto lo cubre.', citas: [3, 1, 3, 99], lider: 'abdias v.', issues: [issue('Modelo de devolución', { citas: [3] }), issue('Pantalla de devolución', { citas: [3], ciclo: 'próximo' })] }],
      issues: [issue('Exportar pedidos a Excel', { proyecto: 'seguridad CARRITO de compras', ciclo: 'actual' })],
      comentarios: [{ issue: 915, comentario: 'Se acordó darle prioridad.', por_que: 'Ya existe.', citas: [4], ciclo: 'proximo' }],
      descartado: [{ tema: 'Cloudflare', motivo: 'Ya está en curso: #923.', citas: [6] }],
    });
    expect(out).toEqual({
      summary: 'Se habló de devoluciones y de un reporte para bodega.',
      projects: [{
        id: 'p1', name: 'Devoluciones de pedidos mayoristas', description: 'Registrar devoluciones.', why: 'Ningún proyecto lo cubre.', cites: [1, 3], lead: 'Abdias V.',
        issues: [
          { id: 'p1-1', title: 'Modelo de devolución', body: '## Qué\nModelo de devolución', why: 'No hay issue parecido.', cites: [3] },
          { id: 'p1-2', title: 'Pantalla de devolución', body: '## Qué\nPantalla de devolución', why: 'No hay issue parecido.', cites: [3], cycle: 'next' },
        ],
      }],
      issues: [{ id: 'i1', title: 'Exportar pedidos a Excel', body: '## Qué\nExportar pedidos a Excel', why: 'No hay issue parecido.', cites: [2], project: 'Seguridad carrito de compras', cycle: 'current' }],
      comments: [{ id: 'c1', issue: 915, issueTitle: "Buscar 'nanez' sin tilde no encuentra clientes", body: 'Se acordó darle prioridad.', why: 'Ya existe.', cites: [4], cycle: 'next' }],
      discarded: [{ topic: 'Cloudflare', why: 'Ya está en curso: #923.', cites: [6] }],
      dropped: [],
    });
    expect(proposalCount(out)).toBe(3);
  });

  it('drops what can not stand, and says why', () => {
    const out = parse({
      proyectos: [
        { nombre: 'Seguridad carrito de compras', citas: [1], issues: [issue('a')] },
        { nombre: 'Sin citas', citas: [], issues: [issue('b')] },
        { nombre: 'Sin issues', citas: [1], issues: [] },
      ],
      issues: [issue('Inventado', { citas: [40] }), issue('', {}), issue('Con proyecto que no existe', { proyecto: 'Otro' })],
      comentarios: [{ issue: 1, comentario: 'x', citas: [1] }, { issue: 923, comentario: '', citas: [1] }],
      lider: 'nadie',
    });
    expect(out.projects).toEqual([]);
    expect(out.issues.map((i) => [i.title, i.project])).toEqual([['Con proyecto que no existe', undefined]]);
    expect(out.comments).toEqual([]);
    expect(out.dropped).toEqual([
      'proyecto "Seguridad carrito de compras": ya existe en Linear',
      'proyecto "Sin citas": sin citas de las notas',
      'proyecto "Sin issues": sin issues',
      'issue "Inventado": sin citas de las notas',
      'issue "(sin título)": sin título o sin descripción',
      'proyecto "Otro" del issue "Con proyecto que no existe": no existe en Linear',
      'comentario en #1: no es un issue abierto del repo',
      'comentario en #923: vacío',
    ]);
  });

  it('without Linear, has no projects: their issues stand alone, with no project, cycle nor lead', () => {
    const out = parse({
      proyectos: [{ nombre: 'Devoluciones', citas: [1], lider: 'Abdias V.', issues: [issue('Modelo de devolución', { ciclo: 'actual' })] }],
      issues: [issue('Exportar', { proyecto: 'Seguridad carrito de compras' })],
    }, { ...CTX, linear: null });
    expect(out.projects).toEqual([]);
    expect(out.issues.map((i) => ({ id: i.id, title: i.title, project: i.project, cycle: i.cycle }))).toEqual([
      { id: 'p1-1', title: 'Modelo de devolución', project: undefined, cycle: undefined },
      { id: 'i1', title: 'Exportar', project: undefined, cycle: undefined },
    ]);
  });

  it('an empty answer is a valid one, and anything but an object is not', () => {
    expect(proposalCount(parse({ resumen: 'Nada nuevo.', proyectos: [], issues: [], comentarios: [], descartado: [] }))).toBe(0);
    expect(() => parseProposals('[]', CTX)).toThrow('no es un objeto JSON');
    expect(() => parseProposals('no', CTX)).toThrow();
  });
});
