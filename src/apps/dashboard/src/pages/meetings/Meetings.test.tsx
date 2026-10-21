// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetShell, showPage, testShell, testSnapshot } from '@apps/dashboard/src/test-shell.js';
import { Meeting } from './Meeting.js';
import { Meetings } from './Meetings.js';

// Invented meetings: one waiting for review, with a project, an issue and a
// comment, and one already created.
const at = '2026-10-15T12:00:00Z';
const issue = (id: string, title: string, extra = {}) => ({ id, title, body: `Cuerpo de ${id}`, why: '', cites: [1], ...extra });
const MEETING = {
  number: 2, repo: 'acme/tienda', title: 'Revisión semanal', at: null, by: 'ana-dev', status: 'review',
  source: { kind: 'pasted', name: null, pages: null }, chars: 40, counts: null, createdAt: at, link: null, bytes: null, original: false,
  text: 'El checkout tarda.\nHay que pagar con transferencia.',
  proposals: {
    summary: 'Se habló del checkout.',
    projects: [{ id: 'P1', name: 'Pagos', description: 'Transferencias', why: '', cites: [2], issues: [issue('P1-I1', 'Mostrar la cuenta')] }],
    issues: [issue('I1', 'El checkout tarda')],
    comments: [{ id: 'C1', issue: 41, issueTitle: 'Correo', body: 'Sale sin número', why: '', cites: [] }],
    discarded: [{ topic: 'Logo', why: 'Lo ve diseño.', cites: [] }],
    at,
  },
  results: {}, events: [{ kind: 'uploaded', by: 'ana-dev', at }], runs: [],
};
const ROWS = [
  { ...MEETING, counts: { projects: 1, issues: 2, comments: 1, discarded: 1 } },
  { ...MEETING, number: 1, title: 'Planificación', status: 'done', counts: { projects: 0, issues: 1, comments: 0, discarded: 0 } },
];

const calls: Array<{ method: string; path: string; body: unknown }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/meetings') return json({ meetings: ROWS });
    if (path === '/api/meetings/2') return json(MEETING);
    if (path.endsWith('/approve')) return json({ created: 3, failed: 0, status: 'done' });
    if (path.endsWith('/discard')) return json({ status: 'discarded' });
    if (path === '/api/snapshot') return json(testSnapshot());
    return json({});
  }));
});
afterEach(() => {
  cleanup();
  resetShell();
  vi.unstubAllGlobals();
});

const shell = testShell();
const show = (page: ReactNode) => showPage(page, { shell, snap: testSnapshot() });

describe('Reuniones, in React', () => {
  it('lists the meetings with their state and opens one', async () => {
    show(<Meetings />);
    expect(await screen.findByText('Revisión semanal')).toBeTruthy();
    expect(screen.getByText('Espera revisión')).toBeTruthy();
    expect(screen.getByText('Creado')).toBeTruthy();
    expect(screen.getByText('2 issues')).toBeTruthy();
    fireEvent.click(screen.getByText('R-1'));
    expect(shell.openMeeting).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByText('+ Subir notas'));
    expect(document.querySelector('#rlayer .dlg')).not.toBeNull();
  });

  it('shows a meeting, its notes, and what each line is cited by', async () => {
    const { container } = show(<Meeting n={2} />);
    expect(await screen.findByText('Se habló del checkout.')).toBeTruthy();
    expect(container.querySelectorAll('.reu-pr')).toHaveLength(4);
    fireEvent.click(screen.getByRole('tab', { name: 'Notas' }));
    expect(container.querySelectorAll('.reu-line')).toHaveLength(2);
    expect(container.querySelector('#reu-l2 .tags')?.textContent).toBe('proyecto');
  });

  it('approves what is marked, with what was changed of it', async () => {
    const { container } = show(<Meeting n={2} />);
    // The tab it was on stays, as when the person comes back to it.
    fireEvent.click(await screen.findByRole('tab', { name: /Propuestas/ }));
    // The project's issue goes with it, the comment stays out, and the issue gets a new title.
    fireEvent.click(screen.getByLabelText('Incluir este proyecto'));
    fireEvent.click(screen.getByLabelText('Incluir este comentario'));
    fireEvent.change(container.querySelectorAll<HTMLInputElement>('input.reu-ti')[2], { target: { value: 'Medir el checkout' } });
    expect(container.querySelector('.reu-approve .sum b')?.textContent).toBe('1 issue');
    fireEvent.click(screen.getByText('Crear seleccionados'));
    await waitFor(() => expect(shell.toast).toHaveBeenCalledWith('Listo: se crearon 3.'));
    expect(calls.find((c) => c.path === '/api/meetings/2/approve')?.body).toEqual({ items: [{ id: 'I1', title: 'Medir el checkout' }] });
    // The sidebar's count, read again.
    await waitFor(() => expect(calls.some((c) => c.path === '/api/snapshot')).toBe(true));
  });

  it('discards the rest once confirmed', async () => {
    show(<Meeting n={2} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Propuestas/ }));
    fireEvent.click(screen.getByText('Descartar todo'));
    await waitFor(() => expect(shell.toast).toHaveBeenCalledWith('Listo: la reunión quedó descartada.'));
    expect(calls.find((c) => c.path === '/api/meetings/2/discard')).toMatchObject({ method: 'POST', body: {} });
  });
});
