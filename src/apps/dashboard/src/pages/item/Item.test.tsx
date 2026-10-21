// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostContext, type Host, type ItemView } from '../../host.js';
import { testHost } from '../../test-host.js';
import { filesKey, type FilesRead } from './files/model.js';
import { Item } from './Item.js';
import { detail, view } from './test-view.js';

// The item's page against a shell that hands it a fixed view: what it
// draws, its keys, and the bodies it sends.

let posted: Array<[string, unknown]> = [];
beforeEach(() => {
  posted = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    // Archivos, read again after a review.
    if (String(input).endsWith('/files/mine')) return json({ viewed: [], review: null });
    if (String(input).endsWith('/files')) return json({ pr: 42, author: 'beto-dev', headSha: 'abc', files: [], threads: [] });
    posted.push([String(input), JSON.parse(String(init?.body ?? 'null'))]);
    return json({ url: 'https://github.com/acme/tienda/pull/42#issuecomment-1' });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(v: ItemView, over: Partial<Host> = {}, files?: FilesRead) {
  const host = testHost({ item: () => v, ...over });
  const qc = new QueryClient();
  if (files) qc.setQueryData(filesKey(v.item.id), files);
  const page = render(
    <QueryClientProvider client={qc}>
      <HostContext.Provider value={host}><Item id={v.item.id} /></HostContext.Provider>
    </QueryClientProvider>,
  );
  return { host, ...page };
}

const actions = [
  { id: 'preview' as const, label: 'Levantar una preview', command: '/preview', help: 'Levanta la app.', target: 42, text: { required: false, label: 'Qué preparar', placeholder: '' }, apps: ['backoffice', 'tienda'], app: 'tienda', preview: '@ronin-bot /preview {app} …' },
];

describe('an item’s page', () => {
  it('shows ronin’s PR in its sections, and goes to another tab with its number', () => {
    const { host, container } = show(view());
    expect([...container.querySelectorAll('.psec h3')].map((h) => h.textContent)).toEqual(['Qué se pidió', 'Decisiones propias']);
    expect(container.querySelector('.psec.decis')).not.toBeNull();
    fireEvent.keyDown(document, { key: '2' });
    expect(host.showDoc).toHaveBeenCalledWith('acme/tienda#41', 'issue');
  });

  it('asks ronin for an adjustment with P, a suggestion and Ctrl+Enter', async () => {
    const { host } = show(view());
    fireEvent.keyDown(document, { key: 'p' });
    const text = document.getElementById('dtext') as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'Mové el teléfono' } });
    fireEvent.click(screen.getByRole('button', { name: /Agregá un test/ }));
    fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual(['/api/items/acme%2Ftienda%2341/decision', { decision: 'adjust', text: 'Mové el teléfono\nAgregá un test para este caso.', closeIssue: true }]);
    await waitFor(() => expect(host.reread).toHaveBeenCalledWith('acme/tienda#41'));
    expect(screen.getByText(/Le pediste un ajuste a ronin/)).toBeTruthy();
  });

  it('asks for an action from the menu: M, its number, the text and the app', async () => {
    const v = view({ detail: { data: detail({ actions }), error: null }, decidable: false });
    const { host } = show(v);
    fireEvent.keyDown(document, { key: 'm' });
    fireEvent.keyDown(document, { key: '1' });
    fireEvent.change(document.getElementById('dlg-text')!, { target: { value: 'un pedido con envío' } });
    fireEvent.change(document.getElementById('dlg-app')!, { target: { value: 'backoffice' } });
    expect(document.getElementById('dlg-prev')!.innerHTML).toBe('@ronin-bot /preview backoffice un pedido con envío');
    fireEvent.click(document.getElementById('dlg-yes')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual(['/api/items/acme%2Ftienda%2341/actions', { action: 'preview', text: 'un pedido con envío', app: 'backoffice' }]);
    await waitFor(() => expect(host.showDoc).toHaveBeenCalledWith('acme/tienda#41', 'pr'));
    expect(document.getElementById('layer')).toBeNull();
  });

  it('sends a review from the head, approving with its summary', async () => {
    const v = view({ decidable: false });
    const files: FilesRead = {
      data: { pr: 42, author: 'beto-dev', headSha: 'abc', files: [], threads: [] },
      viewed: [],
      review: { id: 'R1', threads: [{ id: 'PT1', path: 'a/b.ts', subject: 'line', side: 'RIGHT', line: 3, startLine: null, originalLine: 3, isNew: true, comments: [{ nodeId: 'N1', id: 1, body: 'Esto sobra.', createdAt: '2026-10-21T14:00:00Z' }] }] },
    };
    const { host } = show(v, {}, files);
    fireEvent.click(screen.getByRole('button', { name: /Terminar revisión/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Aprobar/ }));
    fireEvent.change(document.getElementById('rsum')!, { target: { value: 'Bien.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mandar revisión' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual(['/api/items/acme%2Ftienda%2341/files/actions', { action: 'submit', event: 'APPROVE', text: 'Bien.', commitId: 'abc', fixComments: false, autoMerge: true }]);
    await waitFor(() => expect(host.reviewed).toHaveBeenCalledWith('acme/tienda#41', 42, 'APPROVED'));
  });

  it('shows the run going on: what the agent last said and its last steps', () => {
    const live = { runId: 'r1', repo: 'acme/tienda', taskType: 'fix-issue', label: '', account: 'a', worktree: '/w', startedAt: '2026-10-21T14:50:00Z', state: 'running' as const, steps: 3 };
    const v = view({ runs: [live], run: { runId: 'r1', summary: live, lines: [{ type: 'text', text: 'Busco el total.' }, { type: 'tool', name: 'Read', summary: 'total.ts' }, { type: 'tool', name: 'Bash', summary: '$ pnpm test' }] } }, { status: 'running' });
    const { container } = show(v);
    expect(container.querySelector('.livecard .say')?.textContent).toBe('Busco el total.');
    expect([...container.querySelectorAll('.livecard li')].map((li) => li.textContent)).toEqual(['Leyó total.ts', 'Corrió pnpm test']);
  });
});
