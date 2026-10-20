import { describe, it, expect } from 'vitest';
import { accountPlan } from './claude-plans.js';

describe('accountPlan', () => {
  it('counts an account nobody set as Max 5× at $100', () => {
    expect(accountPlan({ values: {} }, 'redmotos')).toEqual({ plan: 'max5', name: 'Max 5×', priceUsd: 100, source: 'defecto' });
  });

  it('takes the plan\'s list price unless one was typed', () => {
    expect(accountPlan({ values: {}, accounts: { a: { plan: 'pro' } } }, 'a')).toMatchObject({ plan: 'pro', priceUsd: 20, source: 'tablero' });
    expect(accountPlan({ values: {}, accounts: { a: { plan: 'team', priceUsd: 150 } } }, 'a')).toMatchObject({ name: 'Team', priceUsd: 150 });
    expect(accountPlan({ values: {}, accounts: { a: { plan: 'otro' } } }, 'a').priceUsd).toBeNull();
  });

  it('ignores an entry edited by hand into something that doesn\'t read', () => {
    const file = { values: {}, accounts: { a: { plan: 'gratis' }, b: 'pro', c: { plan: 'pro', priceUsd: -5 } } } as never;
    expect(accountPlan(file, 'a').source).toBe('defecto');
    expect(accountPlan(file, 'b').source).toBe('defecto');
    expect(accountPlan(file, 'c')).toMatchObject({ plan: 'pro', priceUsd: 20 });
  });
});
