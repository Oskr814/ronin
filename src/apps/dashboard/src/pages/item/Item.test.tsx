// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetShell, showPage, testShell } from '@apps/dashboard/src/test-shell.js';
import { filesKey, type FilesRead } from './files/model.js';
import { Item } from './Item.js';
import type { ItemDetail, ItemRun, SnapshotItem } from '@apps/dashboard/src/shell/hooks.js';
import { detail, doc, item, itemRead, NOW, type ItemRead } from './test-view.js';

// The item's page on what the shell read of it: what it draws, its keys,
// and the bodies it sends.

let posted: Array<[string, unknown]> = [];
let asked: string[] = [];
let snap: unknown;
beforeEach(() => {
  posted = [];
  asked = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const url = String(input);
    if (!init?.method || init.method === 'GET') {
      asked.push(url);
      // Archivos, read again after a review; the item and the snapshot, after writing.
      if (url.endsWith('/files/mine')) return json({ viewed: [], review: null });
      if (url.endsWith('/files')) return json({ pr: 42, author: 'beto-dev', headSha: 'abc', files: [], threads: [] });
      if (url.endsWith('/detail')) return json(detail());
      if (url === '/api/snapshot') return json(snap);
      return json({});
    }
    posted.push([url, JSON.parse(String(init?.body ?? 'null'))]);
    return json({ url: 'https://github.com/acme/tienda/pull/42#issuecomment-1' });
  }));
});
afterEach(() => {
  cleanup();
  resetShell();
  vi.unstubAllGlobals();
});

function show(read: ItemRead = {}, files?: FilesRead) {
  const shown = itemRead(read);
  snap = shown.snap;
  const page = showPage(<Item id={shown.id} />, { shell: testShell(), snap: shown.snap, data: [...shown.data, ...(files ? [[filesKey(shown.id), files] as [string[], unknown]] : [])] });
  return page;
}
// The tab the page shows.
const tab = () => document.querySelector('.doctab[aria-selected="true"]')?.textContent;
// A person's PR on its issue: reviewed here, not decided.
const person = detail({ pr: doc({ number: 42, title: 'Teléfono en la ficha', author: 'beto-dev', url: 'https://github.com/acme/tienda/pull/42', mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'telefono', isDraft: false, reviewDecision: '', decisions: [] }) });

const actions = [
  { id: 'preview' as const, label: 'Levantar una preview', command: '/preview', help: 'Levanta la app.', target: 42, text: { required: false, label: 'Qué preparar', placeholder: '' }, apps: ['backoffice', 'tienda'], app: 'tienda', preview: '@ronin-bot /preview {app} …' },
];

describe('an item’s page', () => {
  it('shows ronin’s PR in its sections, and goes to another tab with its number', () => {
    const { container } = show();
    expect([...container.querySelectorAll('.psec h3')].map((h) => h.textContent)).toEqual(['Qué se pidió', 'Decisiones propias']);
    expect(container.querySelector('.psec.decis')).not.toBeNull();
    fireEvent.keyDown(document, { key: '2' });
    expect(tab()).toBe('Issue');
  });

  // #194: what ronin's internal review asks a person stands out too.
  it('shows the questions of ronin’s PR as a section of their own, standing out', () => {
    const body = '## Qué se pidió\nEl teléfono.\n\n## Preguntas\n1. ¿Va también en el listado?';
    const { container } = show({ detail: detail({ pr: doc({ number: 42, title: 'Teléfono en la ficha', author: 'ronin-bot', url: 'https://github.com/acme/tienda/pull/42', body, mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'ronin/41/slice-1', isDraft: false, reviewDecision: '', decisions: [] }) }) });
    expect(container.querySelector('.psec.decis h3')?.textContent).toBe('Preguntas');
  });

  it('puts the questions under the head, answered with their options or in words, and warns on approving', async () => {
    const questions = [{ text: '¿Va también en el listado?', options: ['Sí, en las dos', 'No, solo en la ficha'] }, { text: '¿Con código de país?', options: [] }];
    const { container } = show({ detail: { ...detail(), questions } });
    expect(container.querySelector('.pqs h3')?.textContent).toContain('2 preguntas para vos');
    fireEvent.click(screen.getByRole('button', { name: 'No, solo en la ficha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Responder' }));
    fireEvent.change(container.querySelector('.pqs textarea')!, { target: { value: 'Sí, +504' } });
    fireEvent.click(screen.getByRole('button', { name: /^Aprobar/ }));
    expect(container.querySelector('.drop .dt')?.textContent).toContain('Tiene 2 preguntas sin responder');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mandar 2 respuestas' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual(['/api/items/acme%2Ftienda%2341/decision', { decision: 'answer', text: 'Respuestas a las preguntas de la descripción:\n\n1. ¿Va también en el listado?\n   Respuesta: No, solo en la ficha\n2. ¿Con código de país?\n   Respuesta: Sí, +504' }]);
    await waitFor(() => expect(container.querySelector('.pqs-sent')).not.toBeNull());
  });

  it('asks ronin for an adjustment with P, a suggestion and Ctrl+Enter', async () => {
    show();
    fireEvent.keyDown(document, { key: 'p' });
    const text = document.getElementById('dtext') as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'Mové el teléfono' } });
    fireEvent.click(screen.getByRole('button', { name: /Agregá un test/ }));
    fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual(['/api/items/acme%2Ftienda%2341/decision', { decision: 'adjust', text: 'Mové el teléfono\nAgregá un test para este caso.', closeIssue: true }]);
    // The item and the snapshot, read again.
    await waitFor(() => expect(asked).toEqual(expect.arrayContaining(['/api/items/acme%2Ftienda%2341/detail', '/api/snapshot'])));
    expect(screen.getByText(/Le pediste un ajuste a ronin/)).toBeTruthy();
  });

  it('asks for an action from the menu: M, its number, the text and the app', async () => {
    show({ detail: { ...person, actions }, doc: 'issue' });
    fireEvent.keyDown(document, { key: 'm' });
    fireEvent.keyDown(document, { key: '1' });
    fireEvent.change(document.getElementById('dlg-text')!, { target: { value: 'un pedido con envío' } });
    fireEvent.change(document.getElementById('dlg-app')!, { target: { value: 'backoffice' } });
    expect(document.getElementById('dlg-prev')!.textContent?.trim()).toBe('@ronin-bot /preview backoffice un pedido con envío');
    fireEvent.click(document.getElementById('dlg-yes')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual(['/api/items/acme%2Ftienda%2341/actions', { action: 'preview', text: 'un pedido con envío', app: 'backoffice' }]);
    // On the PR it went to.
    await waitFor(() => expect(tab()).toBe('PR #42'));
    expect(document.getElementById('layer')).toBeNull();
  });

  it('sends a review from the head, approving with its summary', async () => {
    const files: FilesRead = {
      data: { pr: 42, author: 'beto-dev', headSha: 'abc', files: [], threads: [] },
      viewed: [],
      review: { id: 'R1', threads: [{ id: 'PT1', path: 'a/b.ts', subject: 'line', side: 'RIGHT', line: 3, startLine: null, originalLine: 3, isNew: true, comments: [{ nodeId: 'N1', id: 1, body: 'Esto sobra.', createdAt: '2026-10-21T14:00:00Z' }] }] },
    };
    const { container } = show({ detail: person }, files);
    fireEvent.click(screen.getByRole('button', { name: /Terminar revisión/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Aprobar/ }));
    fireEvent.change(document.getElementById('rsum')!, { target: { value: 'Bien.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mandar revisión' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual(['/api/items/acme%2Ftienda%2341/files/actions', { action: 'submit', event: 'APPROVE', text: 'Bien.', commitId: 'abc', fixComments: false, autoMerge: true }]);
    // The PR shows approved at once.
    await waitFor(() => expect(container.querySelector('.state')?.textContent).toContain('aprobado'));
  });

  it('shows the run going on: what the agent last said and its last steps', () => {
    vi.stubGlobal('EventSource', class { close() {} addEventListener() {} });
    const live = { runId: 'r1', repo: 'acme/tienda', taskType: 'fix-issue', label: '', account: 'a', worktree: '/w', startedAt: '2026-10-21T14:50:00Z', state: 'running' as const, steps: 3 };
    const { container } = show({ item: { status: 'running' }, runs: [live], run: { runId: 'r1', summary: live, lines: [{ type: 'text', text: 'Busco el total.' }, { type: 'tool', name: 'Read', summary: 'total.ts' }, { type: 'tool', name: 'Bash', summary: '$ pnpm test' }] } });
    expect(container.querySelector('.livecard .say')?.textContent).toBe('Busco el total.');
    expect([...container.querySelectorAll('.livecard li')].map((li) => li.textContent)).toEqual(['Leyó total.ts', 'Corrió pnpm test']);
  });

  it("says which slice a slice's PR is, and goes back to its issue", () => {
    const shown = itemRead({ item: { id: 'acme/tienda#43', number: 43, kind: 'pr', title: 'Columnas', pr: undefined }, detail: detail({ ref: { kind: 'pr', number: 43, issue: 41 } as ItemDetail['ref'] }) });
    const spec = item({ slices: [{ index: 0, title: 'Columnas', prNumber: 43, status: 'merged' }, { index: 1, title: 'Endpoint', prNumber: 42, status: 'open' }] as SnapshotItem['slices'] });
    const snapshot = { ...shown.snap, items: [...shown.snap.items, spec] } as typeof shown.snap;
    snap = snapshot;
    const shell = testShell();
    const { container } = showPage(<Item id={shown.id} />, { shell, snap: snapshot, data: shown.data });
    const chip = container.querySelector('.head .goped')!;
    expect(chip.textContent).toBe('slice 1 de 2 de #41');
    fireEvent.click(chip);
    expect(shell.openItem).toHaveBeenCalledWith('acme/tienda#41');
  });

  // Many runs (#363): the last three on the activity line and the
  // transcript's row, the rest in the history.
  const many = () => {
    const at = (min: number) => new Date(NOW - min * 60e3).toISOString();
    const run = (i: number, over: Partial<ItemRun> = {}) => ({ runId: `r${i}`, repo: 'acme/tienda', taskType: 'review-pr', label: '', account: 'a', worktree: '/w', startedAt: at(i * 60), endedAt: at(i * 60 - 5), state: 'ok', steps: 4, durationMs: 300_000, costUsd: 0.5, ...over }) as ItemRun;
    return [run(0), run(1, { taskType: 'fix-comments', state: 'error', error: 'falló' }), run(2), run(3), run(4), run(5, { group: 'preview:41', taskType: 'preview' }), run(6, { group: 'preview:41', taskType: 'preview-data' })];
  };

  it('shows the last three runs and opens the rest in the history', () => {
    vi.setSystemTime(NOW);
    const { container } = show({ runs: many() });
    expect(container.querySelectorAll('.act-line .pills .pill')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Historial (6) →' }));
    const rows = [...container.querySelectorAll('.hist > section > ol > li')];
    expect(rows).toHaveLength(6);
    expect(container.querySelector('.hist .htot')?.textContent).toBe('6 corridas · 1 falló · 35 min · US$3,50');
    // The group is one row, its steps unfold under it.
    fireEvent.click(screen.getByRole('button', { name: /2 pasos/ }));
    expect(rows[5].querySelectorAll(':scope > ol .hrow')).toHaveLength(2);
    // An old one opens its transcript, shown after the last three.
    fireEvent.click(rows[4].querySelector('.hrow')!);
    const pills = [...container.querySelectorAll('.runs .pill:not(.back-ficha)')];
    expect(pills.map((p) => p.getAttribute('aria-pressed'))).toEqual([null, 'false', 'false', 'false', 'true']);
    expect(pills[0].textContent).toBe('Historial6');
    vi.useRealTimers();
  });
});
