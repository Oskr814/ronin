import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// The portal's passwords (#114), with scrypt: each one with its own salt, and
// the parameters stored next to it so they can go up later without breaking
// the passwords already saved. Format: scrypt$N$r$p$salt$hash (base64url).

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
// N=2^15, r=8 needs 32 MiB; node's default cap is exactly that.
const MAX_MEM = 64 * 1024 * 1024;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

function derive(password: string, salt: Buffer, options: ScryptOptions & { N: number }, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, length, { ...options, maxmem: MAX_MEM }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

// Why a new password can't be used, or null when it can.
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Falta la contraseña.';
  if ([...password].length < PASSWORD_MIN) return `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`;
  if ([...password].length > PASSWORD_MAX) return `La contraseña puede tener hasta ${PASSWORD_MAX} caracteres.`;
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P }, KEY_LENGTH);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash, ...rest] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash || rest.length > 0) return false;
  const expected = Buffer.from(hash, 'base64url');
  try {
    const key = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) }, expected.length);
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// Checked against when the email has no account (or no password yet), so
// that answer takes as long as a wrong password and doesn't tell them apart.
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(12).toString('base64url'));
  await verifyPassword(password, await dummy);
}
