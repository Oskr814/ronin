import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// A secret kept at rest (#353: the GitHub token of a dev who decided a
// portal request, until ronin uses it), sealed with AES-256-GCM under a key
// derived from `secret` for `purpose`: the dashboard's session secret seals
// these and its cookies, each with its own key. Opening fails (null) with
// another secret or purpose, or with a value changed by hand.

const VERSION = 's1';

const keyFor = (secret: string, purpose: string) => Buffer.from(hkdfSync('sha256', secret, '', `ronin-${purpose}`, 32));

export function seal(plain: string, secret: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
  const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, sealed, cipher.getAuthTag()].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

export function unseal(value: string, secret: string, purpose: string): string | null {
  const [version, iv, sealed, tag, ...rest] = value.split('.');
  if (version !== VERSION || !iv || !sealed || !tag || rest.length > 0) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, purpose), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(sealed, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
