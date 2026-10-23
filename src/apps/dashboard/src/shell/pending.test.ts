// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { addPending, dropPending, pendingOn, resetPending, sentPending } from './pending.js';

// #368: a comment just written shows until what's read brings it.
describe('what was just written', () => {
  beforeEach(() => resetPending());
  const read = (c: Partial<{ url: string; author: string; body: string }> = {}) => ({ url: 'https://github.com/acme/tienda/issues/7#issuecomment-1', author: 'ana', body: 'otro', ...c });

  it('shows in its own conversation until a read brings it, by its URL or by who wrote what', () => {
    const a = addPending({ repo: 'acme/tienda', number: 7, author: 'oskr', body: 'Va con el cliente nuevo' });
    expect(pendingOn('acme/tienda', 7, [read()]).map((w) => w.id)).toEqual([a]);
    expect(pendingOn('acme/tienda', 8, [])).toEqual([]);
    expect(pendingOn('otra/cosa', 7, [])).toEqual([]);
    expect(pendingOn('acme/tienda', 7, [read({ author: 'oskr', body: 'Va con el cliente nuevo\n' })])).toEqual([]);
    sentPending(a, 'https://github.com/acme/tienda/issues/7#issuecomment-9');
    expect(pendingOn('acme/tienda', 7, [read({ url: 'https://github.com/acme/tienda/issues/7#issuecomment-9', body: 'editado ya' })])).toEqual([]);
  });

  it('lets go of a sent one no read brought after a couple of minutes, and of one dropped', () => {
    const a = addPending({ repo: 'acme/tienda', number: 7, author: 'oskr', body: 'x' });
    const b = addPending({ repo: 'acme/tienda', number: 7, author: 'oskr', body: '', note: 'Se lo asignás a @ronin.' });
    sentPending(a);
    expect(pendingOn('acme/tienda', 7, [], Date.now() + 3 * 60_000).map((w) => w.id)).toEqual([b]);
    dropPending(b);
    expect(pendingOn('acme/tienda', 7, [])).toHaveLength(1);
  });
});
