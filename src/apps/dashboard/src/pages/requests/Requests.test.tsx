// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detailKey } from '@apps/dashboard/src/shell/state.js';
import { detail, doc, item } from '../item/test-view.js';
import { resetShell, showPage, testShell, testSnapshot } from '@apps/dashboard/src/test-shell.js';
import { Request } from './Request.js';
import { Requests } from './Requests.js';

// Invented requests: a person, an app and two repos that don't exist.
const at = (min: number) => new Date(Date.now() - min * 60e3).toISOString();
const row = (number: number, status: string, extra: Record<string, unknown> = {}) => ({
  number, repo: 'acme/tienda', app: 'web', appName: 'Tienda', title: `Pedido ${number}`, status, waitsOn: status === 'asking' ? 'person' : status === 'thinking' ? 'ronin' : null,
  running: false, person: 'Ana Pérez', prototypes: 0, questions: 0, bug: false, createdAt: at(600), lastAt: at(5), ...extra,
});
// 30 open and 3 closed: two pages of Pendientes.
const ROWS = [...Array.from({ length: 30 }, (_, i) => row(40 - i, i % 2 ? 'asking' : 'thinking')), row(3, 'done'), row(2, 'declined'), row(1, 'cancelled')];
const message = (id: number, from: string, text: string, min: number, extra = {}) => ({ id, from, text, images: [], at: at(min), ...extra });
const DETAIL = {
  ...row(7, 'fixing', { issue: 107, bug: true, waitsOn: 'ronin' }),
  email: 'persona@gmail.com',
  messages: [message(1, 'person', 'El carrito se rompe con cantidad 0.', 300, { images: ['foto.png'] }), message(2, 'ronin', 'Lo encontré.', 100)],
  verdict: { kind: 'error', summary: 'El descuento divide por la cantidad.', at: at(290) },
  prototypes: [],
  bug: { steps: 'Poner cantidad 0.', reproductions: [{ round: 1, reproduced: true, steps: ['Agregué con cantidad 0'], test: { kind: 'direct', name: 'descuento con cantidad 0', red: true, green: true, redOutput: 'FAIL', greenOutput: 'PASS' }, fix: 'small', summary: 'Divide por cero.', patch: 'r1.patch', messageId: 2, at: at(110) }] },
  decision: null, interview: null, issue: { number: 107, url: 'https://github.com/acme/tienda/issues/107' }, pr: null, deployed: null,
  activity: { entries: [{ type: 'message', at: at(300), message: message(1, 'person', 'El carrito se rompe con cantidad 0.', 300), first: true }, { type: 'event', at: at(200), event: { kind: 'classified', verdict: 'error', at: at(200) } }], untimed: [] },
  runs: [{ runId: 'r1', repo: 'acme/tienda', taskType: 'portal-reproduce', label: '', account: 'a', worktree: '', startedAt: at(120), endedAt: at(110), durationMs: 600_000, costUsd: 0.5, state: 'ok', steps: 3, lastStep: 'listo' }],
  costUsd: 0.5,
};
const PATCH = 'diff --git a/src/carrito.ts b/src/carrito.ts\n@@ -1 +1 @@\n-  return d / n;\n+  return n ? d / n : 0;';

// A prototype the person approved, waiting for a dev (#353).
const WAITING = {
  ...DETAIL, ...row(8, 'awaiting-dev', { waitsOn: 'team', prototypes: 1 }), bug: null, issue: null,
  verdict: { kind: 'minor', proposal: 'El total se ve en negrita.', summary: 'OrdersPage.tsx', at: at(290) },
  prototypes: [{ round: 1, summary: 'Agrega font-bold a la columna.', patch: 'p1.patch', messageId: 3, at: at(100),
    team: { changes: ['Backoffice: el total de la columna en negrita.'], tests: [{ ok: true, text: '12 tests de pedidos, en verde' }, { ok: false, text: 'El e2e no se corrió: no hay navegador.' }], decide: ['¿También en el PDF del pedido?'], risks: ['Ninguno visible.'] } }],
  messages: [...DETAIL.messages, message(3, 'ronin', 'Listo el prototipo.', 100, { images: ['p1-antes-1.png', 'p1-despues-1.png'], captions: ['Antes: El total en texto normal.', 'Después: El total en negrita.'] })],
  scope: { files: [{ path: 'apps/backoffice/src/Orders.tsx', add: 2, del: 1 }, { path: 'apps/backoffice/src/Orders.test.tsx', add: 5, del: 0 }], areas: ['backoffice'], add: 7, del: 1 },
  devDecision: null,
};
const decided: unknown[] = [];
// A big one the team has, where the person answered the team (#353).
const TEAMS = { ...WAITING, ...row(9, 'big', { waitsOn: 'team', personReplied: true }), bug: null, prototypes: WAITING.prototypes, issue: { number: 109, url: 'https://github.com/acme/tienda/issues/109' }, devDecision: null };
// A question waiting on the person, that expires (#404).
const later = (min: number) => new Date(Date.now() + min * 60e3).toISOString();
const ASKING = {
  ...WAITING, ...row(10, 'asking', { waitsOn: 'person', questions: 1 }), bug: null, prototypes: [], verdict: null,
  expiry: { expiresAt: later(300), remindAt: null, remindedAt: at(60) }, closeNote: null,
};

// jsdom doesn't scroll.
HTMLElement.prototype.scrollTo = () => {};

const asked: string[] = [];
beforeEach(() => {
  asked.length = 0;
  decided.length = 0;
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname;
    asked.push(path);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/requests') return json({ requests: ROWS });
    if (path === '/api/requests/7') return json(DETAIL);
    if (path === '/api/requests/7/reproduction/1') return json({ patch: PATCH });
    if (path === '/api/runs/r1') return json({ summary: DETAIL.runs[0], lines: [{ type: 'text', text: 'Reproduzco el error.' }] });
    if (path === '/api/requests/8') return json(WAITING);
    if (path === '/api/requests/9') return json(TEAMS);
    if (path === '/api/requests/10') return json(ASKING);
    if (path === '/api/requests/10/close') {
      decided.push(JSON.parse(String(init?.body)));
      return json({ ...ASKING, status: 'declined', waitsOn: null, expiry: null });
    }
    if (path === '/api/requests/9/messages') {
      decided.push(JSON.parse(String(init?.body)));
      return json({ ...TEAMS, messages: [...TEAMS.messages, message(3, 'team', '¿Por sucursal o en total?', 0, { by: 'ana-dev' })] });
    }
    if (path === '/api/requests/8/decision') {
      decided.push(JSON.parse(String(init?.body)));
      return json({ ...WAITING, status: 'declined', waitsOn: null, devDecision: { kind: 'decline', by: 'ana-dev', at: at(0), reason: 'Esa pantalla se rehace.' } });
    }
    return json({});
  }));
});
afterEach(() => {
  cleanup();
  resetShell();
  vi.unstubAllGlobals();
});

// The request's issue, in the sidebar and read from GitHub.
const issue107 = item({ id: 'acme/tienda#107', number: 107 });
const shell = testShell();
const show = (page: ReactNode) => showPage(page, {
  shell,
  snap: testSnapshot({ repos: ['acme/tienda', 'acme/web'], pedidosTotal: ROWS.length, portalAdmin: true, items: [issue107] }),
  data: [[detailKey('acme/tienda#107'), detail({ issue: doc({ number: 107, title: 'El total no suma el envío' }) })]],
});

describe('Pedidos, in React', () => {
  it('lists the pending ones a page at a time, filters them and opens one', async () => {
    const { container } = show(<Requests />);
    await waitFor(() => expect(container.querySelector('.pd-t')).not.toBeNull());
    const shown = () => [...container.querySelectorAll('.pd-t tbody .pn')].map((e) => e.textContent);
    expect(shown()).toHaveLength(25);
    expect(screen.getByText('1–25 de 30')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(shown()).toEqual(['P-15', 'P-14', 'P-13', 'P-12', 'P-11']);
    fireEvent.click(screen.getByRole('button', { name: /^Cerrados/ }));
    expect(shown()).toEqual(['P-3', 'P-2', 'P-1']);
    expect(container.querySelector('.pd-pager')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Esperan a la persona/ }));
    expect(shown()).toHaveLength(15);
    fireEvent.click(container.querySelector('.pd-t tbody tr')!);
    expect(shell.openRequest).toHaveBeenCalledWith(39);
    fireEvent.click(screen.getByRole('tab', { name: 'Usuarios ↗' }));
    expect(shell.openPortalAccounts).toHaveBeenCalled();
  });

  it('shows a request on its tabs: activity, reproduction with its diff, issue and runs', async () => {
    const { container } = show(<Request n={7} />);
    await waitFor(() => expect(container.querySelector('.pd-tl')).not.toBeNull());
    expect(screen.getByText('Lo leyó como un reporte de error')).toBeTruthy();
    expect(screen.getByText('ronin va a hacer el arreglo en #107')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Reproducción/ }));
    expect(screen.getByText('✓ Reproducido')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver el diff' }));
    await waitFor(() => expect(container.querySelector('pre.diff')).not.toBeNull());
    expect([...container.querySelectorAll('pre.diff span')].map((s) => s.className)).toEqual(['f', 'h', 'd', 'a']);
    expect(screen.getByText('+1 −1 · 1 archivo')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Issue' }));
    expect(container.querySelector('.pd-ghhead h2')?.textContent).toBe('El total no suma el envío #107');

    fireEvent.click(screen.getByRole('tab', { name: /Conversación/ }));
    fireEvent.click(container.querySelector('.pd-thumbs button')!);
    expect(document.querySelector('#lightbox img')?.getAttribute('src')).toBe('/api/requests/7/img/foto.png');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('#lightbox')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Corridas/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ver corrida →' }));
    expect(await screen.findByText('Reproduzco el error.')).toBeTruthy();
    expect(asked).toContain('/api/runs/r1');
  });

  it('a prototype the person approved waits for a dev, who decides it from Ahora (#353)', async () => {
    const { container } = show(<Request n={8} />);
    expect(await screen.findByText('¿Hace ronin este cambio?')).toBeTruthy();
    expect(container.querySelector('.pd-head .chip')?.textContent).toBe('Decidir si se hace');
    expect(screen.getByText('El total se ve en negrita.')).toBeTruthy();
    // What to decide, and one line of scope and tests; the rest under Detalles (#406).
    expect(screen.getByText('¿También en el PDF del pedido?')).toBeTruthy();
    expect(container.querySelector('.pd-dc-sum')?.textContent).toBe('backoffice2 archivos +7 −1·✓ 1 prueba! 1 sin correr o en rojo');
    expect(container.querySelector('.pd-dc-more')?.textContent).toContain('El e2e no se corrió');
    // Its shots in a pair, compared at full size (#407).
    fireEvent.click(container.querySelector('.pd-pair')!);
    expect(document.querySelector('.cmp .cmp-side.after')?.textContent).toBe('DespuésEl total en negrita.');
    fireEvent.click(screen.getByRole('button', { name: 'Después' }));
    expect(document.querySelectorAll('.cmp .cmp-side')).toHaveLength(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.cmp')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar y desplegar' }));
    expect(screen.getByText(/lo aprueba a tu nombre/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
    fireEvent.click(screen.getByRole('button', { name: 'No hacerlo' }));
    const send = () => screen.getAllByRole('button', { name: 'No hacerlo' }).at(-1) as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Por ejemplo/), { target: { value: 'Esa pantalla se rehace.' } });
    fireEvent.click(send());
    await waitFor(() => expect(decided).toEqual([{ decision: 'decline', reason: 'Esa pantalla se rehace.' }]));
    await waitFor(() => expect(shell.toast).toHaveBeenCalledWith('Cerraste P-8: Ana recibe el motivo.'));
  });

  it('the dev answers «Antes de aprobar» and the answers go with the approval (#413)', async () => {
    show(<Request n={8} />);
    const answer = await screen.findByRole('textbox', { name: 'Tu respuesta: ¿También en el PDF del pedido?' });
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar con revisión' }));
    expect(screen.getByText('No respondiste «Antes de aprobar»: ronin lo hace como propuso.')).toBeTruthy();
    fireEvent.change(answer, { target: { value: ' No, solo en la pantalla. ' } });
    expect(screen.getByText('Con tus respuestas a «Antes de aprobar»: van en el issue y ronin las sigue.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /Nota para el issue/ }), { target: { value: ' Con el mismo gris del encabezado. ' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Aprobar con revisión' }).at(-1)!);
    await waitFor(() => expect(decided).toEqual([{ decision: 'review', answers: [{ question: '¿También en el PDF del pedido?', answer: 'No, solo en la pantalla.' }], note: 'Con el mismo gris del encabezado.' }]));
  });

  it('a request waiting on the person says when it expires, and the team closes it with a reason (#404)', async () => {
    show(<Request n={10} />);
    expect(await screen.findByText(/^Vence el .* \(en 5h\): sin respuesta, se cancela solo\. Le llegó un recordatorio hace 1h\.$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar pedido' }));
    const send = () => screen.getAllByRole('button', { name: 'Cerrar pedido' }).at(-1) as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ya existe en Reportes.' } });
    fireEvent.click(send());
    await waitFor(() => expect(decided).toEqual([{ reason: 'Ya existe en Reportes.' }]));
    await waitFor(() => expect(shell.toast).toHaveBeenCalledWith('Cerraste P-10: Ana recibe el motivo.'));
    expect(screen.queryByRole('button', { name: 'Cerrar pedido' })).toBeNull();
  });

  it('the team writes to the person from Conversación (#353)', async () => {
    show(<Request n={9} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Conversación/ }));
    expect(screen.getByText('Escribirle a Ana')).toBeTruthy();
    expect(screen.getByText(/queda copiado en el issue #109/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/firmado «Equipo de desarrollo»/), { target: { value: '¿Por sucursal o en total?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar a Ana' }));
    await waitFor(() => expect(decided).toEqual([{ text: '¿Por sucursal o en total?', images: [] }]));
    expect(await screen.findByText('ana-dev, del equipo', { exact: false })).toBeTruthy();
  });
});
