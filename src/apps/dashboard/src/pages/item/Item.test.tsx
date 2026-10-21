// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetShell, showPage, testShell } from '@apps/dashboard/src/test-shell.js';
import { filesKey, type FilesRead } from './files/model.js';
import { Item } from './Item.js';
import { detail, doc, itemRead, type ItemRead } from './test-view.js';

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
});
