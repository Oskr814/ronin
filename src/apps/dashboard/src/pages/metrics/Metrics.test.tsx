// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetShell, showPage, testShell, testSnapshot } from '@apps/dashboard/src/test-shell.js';
import { Subscription } from './Subscription.js';
import { Work } from './Work.js';

// Invented data, computed by the server's own functions (domains/metrics).
const DATA = JSON.parse(readFileSync(join(import.meta.dirname, 'fixture.test.json'), 'utf8'));

const asked: string[] = [];
beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x');
    asked.push(url.pathname + url.search);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/metrics/subscription') return json(DATA.subscription);
    if (url.pathname === '/api/metrics') return json(DATA[url.searchParams.get('days') ?? '30']);
    return json({});
  }));
});
afterEach(() => {
  cleanup();
  resetShell();
  vi.unstubAllGlobals();
});

const shell = testShell();
const show = (page: ReactNode) => showPage(page, { shell, snap: testSnapshot({ repos: ['acme/tienda', 'acme/web'] }) });

describe('Métricas → Trabajo, in React', () => {
  it('draws the period it read, and reads another when asked', async () => {
    const { container } = show(<Work />);
    await waitFor(() => expect(container.querySelector('.mt-tiles')).not.toBeNull());
    expect(screen.getByText(/Últimos 30 días/)).toBeTruthy();
    expect(container.querySelectorAll('.mt-tiles .tile')).toHaveLength(6);
    fireEvent.click(screen.getByText('7 días'));
    await waitFor(() => expect(screen.getByText(/Últimos 7 días/)).toBeTruthy());
    expect(asked).toEqual(['/api/metrics?days=30', '/api/metrics?days=7']);
  });

  it('sorts the people and opens one, whose items open in the dashboard', async () => {
    const { container } = show(<Work />);
    await waitFor(() => expect(container.querySelector('.mt-ppl')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Persona' }));
    const logins = () => [...container.querySelectorAll('tr.mt-p .mt-who')].map((e) => e.textContent?.replace('agente', '').trim());
    expect(logins()).toEqual([...logins()].sort());
    fireEvent.click(container.querySelector('tr.mt-p td:nth-child(2)')!);
    await waitFor(() => expect(container.querySelector('tr.mt-det')).not.toBeNull());
    const item = container.querySelector<HTMLButtonElement>('tr.mt-det button.link');
    if (item) {
      fireEvent.click(item);
      expect(shell.openItem).toHaveBeenCalledWith(expect.stringMatching(/^acme\/\w+#\d+$/));
    }
  });
});

describe('Métricas → Suscripción, in React', () => {
  it('draws each account, and one when chosen; the plan opens Ajustes', async () => {
    const { container } = show(<Subscription />);
    await waitFor(() => expect(container.querySelectorAll('.su-acc')).toHaveLength(2));
    fireEvent.change(container.querySelector('#su-cuenta')!, { target: { value: 'personal' } });
    expect(container.querySelectorAll('.su-acc')).toHaveLength(1);
    // The tasks in words: fix-issue is "Resolver issue".
    expect(screen.getAllByText('Resolver issue').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Cambiar el plan'));
    expect(shell.openSettings).toHaveBeenCalledWith('cuentas');
    fireEvent.click(screen.getByRole('tab', { name: 'Trabajo' }));
    expect(shell.openMetrics).toHaveBeenCalledWith('trabajo');
  });
});
