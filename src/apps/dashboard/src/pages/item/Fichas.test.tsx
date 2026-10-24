// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fichaOf } from '@apps/dashboard/src/shell/hooks.js';
import { resetShell, showPage } from '@apps/dashboard/src/test-shell.js';
import type { FindingCard } from './fichas.js';
import { Item } from './Item.js';
import { detail, doc, itemRead, NOW } from './test-view.js';

// An exploration PR's Fichas tab, on what the shell read of it, and an API with invented findings: what it shows, its keys, and
// the bodies it sends.

const iso = (minAgo: number) => new Date(NOW - minAgo * 60e3).toISOString();
const ficha = (id: string, over: Partial<FindingCard> = {}): FindingCard => ({
  app: 'backoffice', id, tipo: 'hallazgo', titulo: `Ficha ${id}`, funcion: 'buscar', functionName: 'Buscar', senal: 'media', gravedad: 'media', charter: 'buscar', viewport: 'desktop', rol: 'admin', estado: 'propuesto',
  path: `exploracion/backoffice/findings/${id}.md`, url: `https://github.com/acme/web/blob/x/${id}.md`, comments: [], pasos: [], observado: '', esperado: '', evidencia: [], antes: [], propuesta: 'Una propuesta.', ...over,
} as FindingCard);
const fichas = [
  ficha('F-0001', { titulo: 'El buscador no avisa' }),
  ficha('F-0002', { titulo: 'El menú tapa el botón', comments: [{ id: 1, author: 'ana-dev', body: 'Esto ya lo vimos.', createdAt: iso(40) }] }),
  ficha('F-0003', { titulo: 'La fecha sale en otro formato' }),
  ficha('F-0004', { titulo: 'El logo se ve borroso', estado: 'rechazado', motivo: 'Ya está cubierto.' }),
];

let posted: Array<[string, unknown]> = [];
let asked: string[] = [];
beforeEach(() => {
  posted = [];
  asked = [];
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (init?.method === 'POST') {
      posted.push([String(input), JSON.parse(String(init.body))]);
      return json({ url: 'https://github.com/acme/web/pull/12#issuecomment-1' });
    }
    asked.push(String(input));
    if (String(input).endsWith('/detail')) return json(PR.data[0][1]);
    if (String(input) === '/api/snapshot') return json(PR.snap);
    return json({ ronin: 'ronin-bot', fetchedAt: iso(1), branch: 'exploracion/backoffice', base: 'main', fichas, runs: [] });
  }));
});
afterEach(() => {
  cleanup();
  resetShell();
  vi.unstubAllGlobals();
});

// The exploration PR acme/web#12 on its Fichas tab.
const pr = doc({ number: 12, title: 'Exploración de backoffice', author: 'ronin-bot', url: 'https://github.com/acme/web/pull/12', mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'exploracion/backoffice', isDraft: false, reviewDecision: '', decisions: [] });
const PR = itemRead({
  item: { id: 'acme/web#12', repo: 'acme/web', number: 12, kind: 'pr', title: 'Exploración de backoffice', status: 'open', pr: undefined },
  detail: detail({ ref: { kind: 'pr', number: 12 }, exploration: true, issue: undefined, pr }),
});
function show() {
  return showPage(<Item id="acme/web#12" />, { snap: PR.snap, data: PR.data });
}
const current = () => document.getElementById('fdetail')!.dataset.current;
const URL_ACTIONS = '/api/items/acme%2Fweb%2312/exploration/actions';

describe('an exploration PR’s Fichas', () => {
  it('lists the findings by where they stand, and goes through them with j and k', async () => {
    const { container, shell } = show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    expect([...container.querySelectorAll('.fgrp span:first-child')].map((s) => s.textContent)).toEqual(['Por decidir', 'Esperando a ronin', 'Rechazadas']);
    expect(container.querySelector('.fprog')!.textContent).toBe('Revisadas 2 de 4');
    expect(container.querySelector('.doctab .c')!.textContent).toBe('4');
    expect(current()).toBe('backoffice/F-0001');
    fireEvent.keyDown(document, { key: 'j' });
    expect(current()).toBe('backoffice/F-0003');
    expect(fichaOf('acme/web#12')).toEqual({ ficha: 'backoffice/F-0003', open: true });
    fireEvent.keyDown(document, { key: 'k' });
    expect(current()).toBe('backoffice/F-0001');
  });

  it('marks one to approve with a, and goes on to the next one to decide', async () => {
    const { container } = show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    fireEvent.keyDown(document, { key: 'a' });
    expect(current()).toBe('backoffice/F-0003');
    expect(JSON.parse(localStorage.getItem('ronin-listas:acme/web#12')!)).toEqual(['backoffice/F-0001']);
    expect([...container.querySelectorAll('.fgrp span:first-child')].map((s) => s.textContent)).toContain('Listas para aprobar');
  });

  it('rejects one with r, a quick reason and the button', async () => {
    const { shell } = show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    fireEvent.keyDown(document, { key: 'r' });
    fireEvent.click(screen.getByRole('button', { name: 'Ya está cubierto' }));
    expect(document.getElementById('fdlg-prev')!.textContent?.trim()).toBe('Rechazo esta ficha: Ya está cubierto');
    fireEvent.click(document.getElementById('fdlg-yes')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([URL_ACTIONS, { action: 'rechazar', ficha: 'backoffice/F-0001', text: 'Ya está cubierto' }]);
    await waitFor(() => expect(document.getElementById('flayer')).toBeNull());
    expect(shell.toast).toHaveBeenCalledWith('Comentaste en F-0001. ronin lo va a aplicar y te responde en el hilo.', 'https://github.com/acme/web/pull/12#issuecomment-1');
  });

  it('lets the rejection go again when the GitHub session ran out on the way', async () => {
    const { shell } = show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    const fetch = vi.mocked(globalThis.fetch);
    const answer = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => (init?.method === 'POST'
      ? new Response(JSON.stringify({ error: 'Tu sesión de GitHub venció o se revocó. Volvé a entrar.' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      : answer(input, init)));
    fireEvent.keyDown(document, { key: 'r' });
    fireEvent.click(screen.getByRole('button', { name: 'Ya está cubierto' }));
    fireEvent.click(document.getElementById('fdlg-yes')!);
    await waitFor(() => expect(shell.unauthorized).toHaveBeenCalled());
    const button = document.getElementById('fdlg-yes') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Rechazar');
  });

  it('asks for changes with c, redoing the after, with Ctrl+Enter', async () => {
    show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    fireEvent.keyDown(document, { key: 'c' });
    const text = document.getElementById('fdlg-text')!;
    fireEvent.change(text, { target: { value: 'Que tenga un ícono' } });
    fireEvent.click(document.getElementById('fdlg-redo')!);
    fireEvent.keyDown(text, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([URL_ACTIONS, { action: 'cambios', ficha: 'backoffice/F-0001', text: 'Que tenga un ícono', redo: true }]);
  });

  it('asks for an issue and a question from Más, and Escape closes the dialog', async () => {
    show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Preguntarle a ronin/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.getElementById('flayer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Pedir un issue aparte/ }));
    fireEvent.change(document.getElementById('fdlg-text')!, { target: { value: 'Revisar los filtros' } });
    expect(document.getElementById('fdlg-prev')!.textContent?.trim()).toBe('Abrí un issue aparte: Revisar los filtros');
    fireEvent.click(document.getElementById('fdlg-yes')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([URL_ACTIONS, { action: 'issue', ficha: 'backoffice/F-0001', text: 'Revisar los filtros' }]);
  });

  it('sends a finding to development from Más, with or without context', async () => {
    const { shell } = show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Desarrollar ya/ }));
    expect(document.getElementById('fdlg-prev')!.textContent?.trim()).toBe('Desarrollar ya.');
    expect((document.getElementById('fdlg-yes') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(document.getElementById('fdlg-text')!, { target: { value: 'Es urgente' } });
    expect(document.getElementById('fdlg-prev')!.textContent?.trim()).toBe('Desarrollar ya: Es urgente');
    fireEvent.click(document.getElementById('fdlg-yes')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([URL_ACTIONS, { action: 'desarrollar', ficha: 'backoffice/F-0001', text: 'Es urgente' }]);
    await waitFor(() => expect(shell.toast).toHaveBeenCalledWith('Mandaste F-0001 a desarrollar. ronin abre su issue y te responde en el hilo con el número.', expect.anything()));
  });

  it('comments on a finding from the box under its thread', async () => {
    show();
    fireEvent.click(await screen.findByText('El menú tapa el botón', { selector: '.tl' }));
    expect(screen.getByText('Esperando a ronin', { selector: 'b' })).toBeTruthy();
    const box = document.getElementById('fcomment')!;
    fireEvent.change(box, { target: { value: 'Gracias.' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([URL_ACTIONS, { action: 'comentar', ficha: 'backoffice/F-0002', text: 'Gracias.' }]);
    await waitFor(() => expect((document.getElementById('fcomment') as HTMLTextAreaElement).value).toBe(''));
  });

  it('comments on the whole PR and finishes the review from the head', async () => {
    const { shell } = show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    fireEvent.click(screen.getByRole('button', { name: 'Comentario general' }));
    fireEvent.change(document.getElementById('fdlg-text')!, { target: { value: 'Las de búsqueda primero' } });
    expect(document.getElementById('fdlg-prev')!.textContent?.trim()).toBe('@ronin-agent Las de búsqueda primero');
    fireEvent.click(document.getElementById('fdlg-yes')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual(['/api/items/acme%2Fweb%2312/exploration/general', { text: 'Las de búsqueda primero' }]);
    await waitFor(() => expect(document.getElementById('flayer')).toBeNull());
    // The PR, read again.
    await waitFor(() => expect(asked).toContain('/api/items/acme%2Fweb%2312/detail'));

    // F-0002 waits on ronin: finishing waits for it.
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar…' }));
    await screen.findByText(/ronin todavía está aplicando comentarios en F-0002/);
    expect(screen.getByText(/Quedan 2 fichas sin revisar \(F-0001, F-0003\)/)).toBeTruthy();
    expect((document.getElementById('fdlg-yes') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.getElementById('fdlg-text')!, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual(['/api/items/acme%2Fweb%2312/exploration/approve', {}]);
  });
});

// With a database (#446): approving and rejecting are kept in ronin, shared
// with whoever reviews the PR, and written into it when it's finished.
describe('an exploration PR’s Fichas, decided in ronin', () => {
  const URL_DECISION = '/api/items/acme%2Fweb%2312/exploration/decision';
  let decisiones: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    decisiones = [];
    const answer = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (init?.method === 'POST' && String(input) === URL_DECISION) {
        const body = JSON.parse(String(init.body)) as { ficha: string; decision: string | null; text?: string };
        posted.push([String(input), body]);
        decisiones = decisiones.filter((d) => d.ficha !== body.ficha);
        if (body.decision) decisiones.push({ ficha: body.ficha, decision: body.decision, reason: body.text ?? null, by: 'ana-dev', at: iso(0), applied: false });
        return json({ decisiones });
      }
      if ((!init?.method || init.method === 'GET') && !String(input).endsWith('/detail') && String(input) !== '/api/snapshot') {
        asked.push(String(input));
        return json({ ronin: 'ronin-bot', fetchedAt: iso(1), branch: 'exploracion/backoffice', base: 'main', fichas, runs: [], decisiones });
      }
      return answer(input, init);
    });
  });

  it('marks one to approve for everyone with a, and takes it back', async () => {
    const { container } = show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    fireEvent.keyDown(document, { key: 'a' });
    await waitFor(() => expect(posted).toContainEqual([URL_DECISION, { ficha: 'backoffice/F-0001', decision: 'aprobar' }]));
    expect(localStorage.getItem('ronin-listas:acme/web#12')).toBeNull();
    expect([...container.querySelectorAll('.fgrp span:first-child')].map((s) => s.textContent)).toContain('Listas para aprobar');
    fireEvent.click(screen.getByText('El buscador no avisa', { selector: '.tl' }));
    await waitFor(() => expect(container.querySelector('.banner.ok')?.textContent).toContain('Para aprobar por ana-dev'));
    fireEvent.keyDown(document, { key: 'a' });
    await waitFor(() => expect(posted).toContainEqual([URL_DECISION, { ficha: 'backoffice/F-0001', decision: null }]));
  });

  it('rejects one in ronin, without a comment, and undoes it', async () => {
    const { container, shell } = show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    fireEvent.keyDown(document, { key: 'r' });
    expect(document.getElementById('fdlg-said')!.textContent).toContain('Queda rechazada en ronin');
    fireEvent.click(screen.getByRole('button', { name: 'Ya está cubierto' }));
    fireEvent.click(document.getElementById('fdlg-yes')!);
    await waitFor(() => expect(document.getElementById('flayer')).toBeNull());
    expect(posted).toEqual([[URL_DECISION, { ficha: 'backoffice/F-0001', decision: 'rechazar', text: 'Ya está cubierto' }]]);
    expect(shell.toast).toHaveBeenCalledWith('Rechazaste F-0001. Se escribe en el PR al finalizar la revisión.');
    // It went to the rejected ones: the next one to decide is shown.
    await waitFor(() => expect(current()).toBe('backoffice/F-0003'));
    fireEvent.click(screen.getByText('El buscador no avisa', { selector: '.tl' }));
    await waitFor(() => expect(container.querySelector('.banner.crit')?.textContent).toContain('Ya está cubierto'));
    fireEvent.click(container.querySelector('[data-fundo]')!);
    await waitFor(() => expect(posted).toContainEqual([URL_DECISION, { ficha: 'backoffice/F-0001', decision: null }]));
    await waitFor(() => expect(container.querySelector('.banner.crit')).toBeNull());
  });

  it('shows what someone else decided, and hands this browser’s old marks to ronin once', async () => {
    decisiones = [{ ficha: 'backoffice/F-0003', decision: 'rechazar', reason: 'No aplica', by: 'beto-dev', at: iso(5), applied: false }];
    localStorage.setItem('ronin-listas:acme/web#12', JSON.stringify(['backoffice/F-0001']));
    const { container } = show();
    await screen.findByText('El buscador no avisa', { selector: '.tl' });
    await waitFor(() => expect(posted).toContainEqual([URL_DECISION, { ficha: 'backoffice/F-0001', decision: 'aprobar' }]));
    expect(JSON.parse(localStorage.getItem('ronin-listas:acme/web#12')!)).toEqual([]);
    const rejected = [...container.querySelectorAll('.frow.rej .tl')].map((r) => r.textContent);
    expect(rejected).toContain('La fecha sale en otro formato');
  });
});
