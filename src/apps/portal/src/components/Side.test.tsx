// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Summary } from '../api.js';
import { Side } from './Side.js';

afterEach(cleanup);

const ME = { name: 'Ana Pérez', email: 'persona@gmail.com', apps: [], today: { used: 0, limit: 3 } };
const req = (number: number, status: string) => ({ number, title: `Pedido ${number}`, appName: 'Backoffice', status }) as Summary;
const REQUESTS = [req(9, 'asking'), req(8, 'proposed'), req(7, 'thinking'), req(6, 'big'), req(5, 'answered'), req(4, 'done'), req(3, 'cancelled'), req(2, 'declined'), req(1, 'some-new-status')];

const side = (requests = REQUESTS) => render(<Side me={ME} requests={requests} current={null} onNew={vi.fn()} onOpen={vi.fn()} onOut={vi.fn()} />);
const filter = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const shown = () => screen.queryAllByText(/^Pedido \d+$/).map((e) => e.textContent);

describe('the side list filters (#422)', () => {
  it('counts each filter, a status no filter knows with the team', () => {
    side();
    expect(filter('Esperando tu respuesta').textContent).toBe('Esperando tu respuesta2');
    expect(filter('En curso').textContent).toBe('En curso1');
    expect(filter('Con el equipo').textContent).toBe('Con el equipo2');
    expect(filter('Listos').textContent).toBe('Listos2');
    expect(filter('Cancelados').textContent).toBe('Cancelados2');
  });

  it('shows all the requests until a filter is picked, and all again on a second click', () => {
    side();
    expect(shown()).toHaveLength(9);
    fireEvent.click(filter('Listos'));
    expect(filter('Listos').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Listos' })).toBeTruthy();
    expect(shown()).toEqual(['Pedido 5', 'Pedido 4']);
    fireEvent.click(filter('Listos'));
    expect(shown()).toHaveLength(9);
    expect(screen.getByRole('heading', { name: 'Mis pedidos' })).toBeTruthy();
  });

  it('says so when a filter has none, and has no filters without requests', () => {
    side([req(4, 'done')]);
    fireEvent.click(filter('Cancelados'));
    expect(screen.getByText('No tienes pedidos aquí.')).toBeTruthy();
    cleanup();
    side([]);
    expect(screen.queryByRole('button', { name: /^Listos/ })).toBeNull();
    expect(screen.getByText('Todavía no tienes pedidos.')).toBeTruthy();
  });
});
