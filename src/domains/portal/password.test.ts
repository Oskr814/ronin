import { describe, it, expect } from 'vitest';
import { hashPassword, passwordProblem, verifyPassword } from './password.js';

describe('portal passwords', () => {
  it('verifies the password it hashed, and nothing else', async () => {
    const stored = await hashPassword('una clave larga');
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('una clave larga', stored)).toBe(true);
    expect(await verifyPassword('una clave larga ', stored)).toBe(false);
    expect(await verifyPassword('una clave larga', 'texto plano')).toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hashPassword('una clave larga')).not.toBe(await hashPassword('una clave larga'));
  });

  it('asks for at least 10 characters', () => {
    expect(passwordProblem('corta')).toMatch(/al menos 10/);
    expect(passwordProblem(undefined)).toMatch(/Falta/);
    expect(passwordProblem('ñandú-ñandú')).toBeNull();
  });
});
