import { describe, expect, it } from 'vitest';
import { seal, unseal } from './sealed.js';

const SECRET = 'x'.repeat(40);

describe('sealed', () => {
  it('opens what it sealed, only with the same secret and purpose', () => {
    const value = seal('gho_inventado', SECRET, 'dev-decision');
    expect(value).not.toContain('gho_inventado');
    expect(unseal(value, SECRET, 'dev-decision')).toBe('gho_inventado');
    expect(unseal(value, 'y'.repeat(40), 'dev-decision')).toBeNull();
    expect(unseal(value, SECRET, 'otra-cosa')).toBeNull();
  });

  it("doesn't open a value changed by hand", () => {
    const [v, iv, sealed, tag] = seal('gho_inventado', SECRET, 'dev-decision').split('.');
    // The first character always changes the first byte; the last two may
    // already be what replaces them.
    const changed = `${sealed[0] === 'A' ? 'B' : 'A'}${sealed.slice(1)}`;
    expect(unseal([v, iv, changed, tag].join('.'), SECRET, 'dev-decision')).toBeNull();
    expect(unseal('basura', SECRET, 'dev-decision')).toBeNull();
  });
});
