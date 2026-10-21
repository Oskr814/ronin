import { describe, expect, it } from 'vitest';
import { STORE_LOCKS } from './backend.js';

describe('STORE_LOCKS', () => {
  it('gives each store a key of its own', () => {
    const keys = Object.values(STORE_LOCKS);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
