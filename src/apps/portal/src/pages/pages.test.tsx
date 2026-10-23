// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Login } from './Gate.js';
import { RequestView } from './RequestView.js';

// The page against a fake API: each answer by path.
let answers: Record<string, () => Response>;
const calls: Array<{ path: string; body: unknown }> = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return (answers[`${init?.method ?? 'GET'} ${path}`] ?? (() => json({ error: 'no existe' }, 404)))();
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);

const ME = { name: 'Ana Pérez', email: 'persona@gmail.com', apps: [], today: { used: 0, limit: 3 } };

describe('the login', () => {
  it('says what the server said on a wrong password, keeps the email, and enters with the right one', async () => {
    const onIn = vi.fn();
    answers = { 'POST /api/portal/login': () => json({ error: 'Correo o contraseña incorrectos.' }, 401) };
    wrap(<Login onIn={onIn} />);
    fireEvent.change(screen.getByLabelText('Correo'), { target: { value: 'persona@gmail.com' } });
    fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'mala' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Correo o contraseña incorrectos.');
    expect(onIn).not.toHaveBeenCalled();

    answers['POST /api/portal/login'] = () => json(ME);
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(onIn).toHaveBeenCalledWith(ME));
    expect(calls.at(-1)).toEqual({ path: '/api/portal/login', body: { email: 'persona@gmail.com', password: 'mala' } });
  });
});

describe('a request in its interview', () => {
  const question = (id: string, kind: string, text: string, extra = {}) => ({ id, kind, text, ...extra });
  const DETAIL = {
    number: 3, title: 'Un reporte', repo: 'acme/tienda', app: 'backoffice', appName: 'Acme · Backoffice', status: 'interviewing',
    cancellable: true, adjustmentsLeft: 2, interview: { round: 1, rounds: 2, correctionsLeft: 2 }, createdAt: '2026-10-20T15:00:00Z', updatedAt: '2026-10-20T15:00:00Z',
    messages: [
      { id: 1, from: 'person', text: 'Un reporte', at: '2026-10-20T15:00:00Z', images: [] },
      { id: 2, from: 'ronin', text: 'Unas preguntas.', at: '2026-10-20T15:01:00Z', images: [], questions: [
        question('quien', 'one', '¿Quién lo usa?', { options: ['Administración', 'Gerencia'], other: true }),
        question('formato', 'many', '¿En qué formato?', { options: ['Excel', 'PDF'] }),
      ] },
    ],
  };

  it('follows the answers, asks for the missing one, and sends them as indexes', async () => {
    answers = {
      'GET /api/portal/requests/3': () => json(DETAIL),
      'POST /api/portal/requests/3/interview': () => json({ ...DETAIL, status: 'thinking', messages: [...DETAIL.messages, { id: 3, from: 'person', text: '', at: '2026-10-20T15:02:00Z', images: [], answers: [{ id: 'quien', question: '¿Quién lo usa?', answer: 'Otra: Contabilidad' }] }] }),
      'GET /api/portal/requests': () => json([]),
    };
    wrap(<RequestView n={3} me={ME} onMenu={() => {}} onZoom={() => {}} onMissing={() => {}} />);
    await screen.findByText('¿Quién lo usa?');
    expect(screen.getByText(/de 2 respondidas/).textContent).toBe('0 de 2 respondidas');

    fireEvent.change(screen.getByLabelText('Otra respuesta'), { target: { value: 'Contabilidad' } });
    expect((screen.getAllByRole('radio').at(-1) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/de 2 respondidas/).textContent).toBe('1 de 2 respondidas');

    fireEvent.click(screen.getByRole('button', { name: 'Enviar respuestas' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Te falta responder: «¿En qué formato?». Si no sabes, marca «No sé».');

    fireEvent.click(screen.getByLabelText('PDF'));
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enviar respuestas' })));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/portal/requests/3/interview')).toBe(true));
    expect(calls.find((c) => c.path === '/api/portal/requests/3/interview')?.body).toEqual({
      answers: [{ id: 'quien', choices: [], other: 'Contabilidad' }, { id: 'formato', choices: [1] }],
      note: '',
      images: [],
    });
    expect(await screen.findByText('ronin está leyendo tus respuestas…', { exact: false })).toBeTruthy();
  });
});

describe('a request answered by ronin (#372)', () => {
  const DETAIL = {
    number: 4, title: 'Un botón', repo: 'acme/tienda', app: 'backoffice', appName: 'Acme · Backoffice', status: 'answered',
    cancellable: true, adjustmentsLeft: 2, interview: { round: 0, rounds: 2, correctionsLeft: 2 }, createdAt: '2026-10-20T15:00:00Z', updatedAt: '2026-10-20T15:00:00Z',
    messages: [
      { id: 1, from: 'person', text: 'Un botón para exportar', at: '2026-10-20T15:00:00Z', images: [] },
      { id: 2, from: 'ronin', text: 'Ya está en la pantalla de reportes.', at: '2026-10-20T15:01:00Z', images: [] },
    ],
  };

  it('says a send went, and a message that arrives below what the person reads', async () => {
    const sent = { ...DETAIL, messages: [...DETAIL.messages, { id: 3, from: 'person', text: 'Gracias', at: '2026-10-20T15:02:00Z', images: [] }] };
    answers = { 'GET /api/portal/requests/4': () => json(DETAIL), 'POST /api/portal/requests/4/messages': () => json(sent), 'GET /api/portal/requests': () => json([]) };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><RequestView n={4} me={ME} onMenu={() => {}} onZoom={() => {}} onMissing={() => {}} /></QueryClientProvider>);
    await screen.findByText('Ya está en la pantalla de reportes.');

    fireEvent.change(screen.getByPlaceholderText(/Escríbele a ronin/), { target: { value: 'Gracias' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enviar' })));
    expect(await screen.findByRole('button', { name: '✓ Enviado' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mensaje nuevo ↓' })).toBeNull();

    // The person scrolls up; ronin answers.
    const thread = document.getElementById('thread')!;
    Object.defineProperties(thread, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
    fireEvent.scroll(thread);
    act(() => queryClient.setQueryData(['request', 4], { ...sent, messages: [...sent.messages, { id: 4, from: 'ronin', text: 'De nada.', at: '2026-10-20T15:03:00Z', images: [] }] }));
    expect(await screen.findByRole('button', { name: 'Mensaje nuevo ↓' })).toBeTruthy();
    expect(document.querySelector('[aria-live]')?.textContent).toBe('ronin te escribió: De nada.');
  });
});
