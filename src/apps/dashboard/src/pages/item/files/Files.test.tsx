// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetShell, showPage } from '@apps/dashboard/src/test-shell.js';
import { Item } from '../Item.js';
import { detail, doc, itemRead } from '../test-view.js';

// Archivos of a person's PR, on what the shell read of it, and a server that answers with invented files: what's sent when
// commenting, replying, resolving, marking as viewed and finishing the review.

const at = '2026-10-21T14:00:00Z';
const files = {
  pr: 50, author: 'beto-dev', headSha: 'def5678',
  files: [
    { path: 'web/src/Lista.tsx', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n const d = 5;' },
    { path: 'web/src/orden.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1,1 @@\n+export const orden = 1;' },
  ],
  threads: [{ id: 'T1', path: 'web/src/Lista.tsx', subject: 'line', side: 'RIGHT', line: 3, startLine: null, originalLine: 3, isResolved: false, isOutdated: false, url: 'https://github.com/acme/tienda/pull/50#discussion_r1', comments: [{ id: 11, author: 'ana-dev', body: '¿Por qué 4?', createdAt: at, url: 'https://github.com/acme/tienda/pull/50#discussion_r1' }] }],
};
let mine: { viewed: string[]; review: unknown } = { viewed: [], review: null };
let posted: Array<[string, unknown]> = [];
let asked: string[] = [];
beforeEach(() => {
  posted = [];
  asked = [];
  mine = { viewed: [], review: null };
  // A desk's window: diffs can go side by side.
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const url = String(input);
    if (url.endsWith('/files/mine')) return json(mine);
    if (url.endsWith('/files')) return json(files);
    if (!init?.method || init.method === 'GET') {
      asked.push(url);
      return json(url.endsWith('/detail') ? PR : url === '/api/snapshot' ? shown.snap : {});
    }
    posted.push([url, JSON.parse(String(init?.body ?? 'null'))]);
    return json({ url: 'https://github.com/acme/tienda/pull/50#discussion_r2' });
  }));
});
afterEach(() => {
  cleanup();
  resetShell();
  vi.unstubAllGlobals();
});

// A person's PR, without an issue, on its Archivos tab; carla-dev looks.
const PR = detail({ ref: { kind: 'pr', number: 50 }, issue: undefined, pr: doc({ number: 50, title: 'Ordenar la lista', author: 'beto-dev', url: 'https://github.com/acme/tienda/pull/50', mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'orden', isDraft: false, reviewDecision: '', decisions: [] }) });
const person = () => itemRead({ item: { id: 'acme/tienda#50', number: 50, kind: 'pr' }, detail: PR, doc: 'files', me: 'carla-dev' });
let shown: ReturnType<typeof person>;
function show(read: ReturnType<typeof person>) {
  shown = read;
  return showPage(<Item id={read.id} />, { snap: read.snap, data: read.data }).shell;
}
const FILES = '/api/items/acme%2Ftienda%2350/files/actions';

describe('Archivos', () => {
  it('comments a range of lines at once, with a suggestion', async () => {
    show(person());
    await screen.findByText('0 de 2 vistos');
    // The new side's lines 2 and 3 (b = 3, c = 4): clicked, then Shift+clicked.
    const added = document.querySelectorAll('.fcard')[0].querySelectorAll('tr.ln.add td.fl');
    fireEvent.click(added[0]);
    fireEvent.click(added[1], { shiftKey: true });
    const box = document.getElementById('fcbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Mejor así:' } });
    fireEvent.click(screen.getByRole('button', { name: /Sugerir cambio/ }));
    expect((document.getElementById('fcbox') as HTMLTextAreaElement).value).toBe('Mejor así:\n\n```suggestion\nconst b = 3;\nconst c = 4;\n```\n');
    fireEvent.click(screen.getByRole('button', { name: 'Comentar ya' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([FILES, { action: 'comment', path: 'web/src/Lista.tsx', commitId: 'def5678', subject: 'line', text: 'Mejor así:\n\n```suggestion\nconst b = 3;\nconst c = 4;\n```\n', side: 'RIGHT', line: 3, startLine: 2 }]);
    await waitFor(() => expect(document.getElementById('fcbox')).toBeNull());
  });

  it('starts a review on the whole file with Ctrl+Enter', async () => {
    const shell = show(person());
    await screen.findByText('0 de 2 vistos');
    fireEvent.click(screen.getAllByRole('button', { name: 'Comentar archivo' })[1]);
    const box = document.getElementById('fcbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Va en lib/.' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([FILES, { action: 'comment', path: 'web/src/orden.ts', commitId: 'def5678', subject: 'file', text: 'Va en lib/.', review: true }]);
    await waitFor(() => expect(shell.toast).toHaveBeenCalledWith('Empezaste una revisión: nadie la ve hasta que la mandes.'));
    // The PR, read again.
    await waitFor(() => expect(asked).toContain('/api/items/acme%2Ftienda%2350/detail'));
  });

  it('replies on a thread and resolves it', async () => {
    show(person());
    await screen.findByText('¿Por qué 4?');
    fireEvent.click(screen.getByRole('button', { name: 'Responder…' }));
    fireEvent.change(document.getElementById('fcbox')!, { target: { value: 'Porque sí.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Responder ya' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([FILES, { action: 'reply', commentId: 11, text: 'Porque sí.' }]);
    await waitFor(() => expect(document.getElementById('fcbox')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Resolver conversación' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual([FILES, { action: 'resolve', threadId: 'T1', resolved: true }]);
  });

  it('marks a file as viewed with v, and goes on to the next one not viewed', async () => {
    show(person());
    await screen.findByText('0 de 2 vistos');
    fireEvent.keyDown(document, { key: 'v' });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([FILES, { action: 'viewed', path: 'web/src/Lista.tsx', viewed: true }]);
    expect(document.querySelector('.ffile[aria-current="true"] .nm')?.textContent).toBe('orden.ts');
    expect(document.querySelector('.fseen')?.textContent).toBe('1 de 2 vistos');
  });

  it('edits and deletes a pending comment, and sends the review from the toolbar', async () => {
    mine = { viewed: [], review: { id: 'R1', threads: [{ id: 'PT1', path: 'web/src/orden.ts', subject: 'line', side: 'RIGHT', line: 1, startLine: null, originalLine: 1, isNew: true, comments: [{ nodeId: 'PC1', id: 1, body: 'Sobra.', createdAt: at }] }] } };
    show(person());
    await screen.findByText('Sobra.');
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.change(document.getElementById('fcbox')!, { target: { value: 'Sobra, creo.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([FILES, { action: 'pending-edit', commentId: 'PC1', text: 'Sobra, creo.' }]);
    await waitFor(() => expect(document.getElementById('fcbox')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Borrar' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual([FILES, { action: 'pending-delete', commentId: 'PC1' }]);
    fireEvent.click(document.querySelector('.ftool .frevb')!);
    fireEvent.click(screen.getByRole('radio', { name: /Pedir cambios/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mandar revisión' }));
    await waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[2]).toEqual([FILES, { action: 'submit', event: 'REQUEST_CHANGES', text: '', commitId: 'def5678', fixComments: false, autoMerge: false }]);
  });
});
