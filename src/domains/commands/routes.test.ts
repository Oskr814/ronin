import { describe, expect, it } from 'vitest';
import type { EventHub, LiveEvent } from '@platform/events/bus.js';
import { eventsRoutes } from './routes.js';

// The stream of what changed, on a hub of its own: only the repos the
// session sees, and a 404 without a database.
function fakeHub() {
  const listeners = new Set<(e: LiveEvent) => void>();
  return {
    hub: { subscribe: (l: (e: LiveEvent) => void) => (listeners.add(l), () => listeners.delete(l)) } as unknown as EventHub,
    emit: (e: LiveEvent) => listeners.forEach((l) => l(e)),
    listening: () => listeners.size,
  };
}
const env = { session: { login: 'ana-dev', token: 't' }, access: { admin: false, repos: [{ repo: 'acme/web', permission: 'triage' as const }] } };

describe('the tablero’s stream of what changed', () => {
  it('sends what changed in the repos the session sees, and lets go when the page leaves', async () => {
    const { hub, emit, listening } = fakeHub();
    const controller = new AbortController();
    const res = await eventsRoutes(() => hub).request('/', { signal: controller.signal }, env);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const read = async (until: string) => {
      let text = '';
      while (!text.includes(until)) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    };
    expect(await read('event: ready')).toContain('event: ready');
    emit({ type: 'command', repo: 'acme/otro', number: 1, id: '1', status: 'queued' });
    emit({ type: 'command', repo: 'acme/web', number: 12, id: '2', status: 'queued' });
    const got = await read('"id":"2"');
    expect(got).not.toContain('acme/otro');
    expect(got).toContain('event: command');
    emit({ type: 'reconnected' });
    expect(await read('event: reconnected')).toContain('reconnected');
    controller.abort();
    await reader.cancel();
    await expect.poll(listening).toBe(0);
  });

  it('is not there without a database', async () => {
    expect((await eventsRoutes(() => null).request('/', {}, env)).status).toBe(404);
  });
});
