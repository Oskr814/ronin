import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const githubApp = { appId: '', privateKeyPath: '' };
vi.mock('../config/config.js', () => ({ config: { githubApp } }));

const { appJwt, mintReadToken, READ_PERMISSIONS, ReadTokenError } = await import('./read-token.js');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  githubApp.appId = '';
  githubApp.privateKeyPath = '';
});
afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('appJwt', () => {
  it("is signed with the App's key, issued by the App, and short-lived", () => {
    const now = Date.UTC(2026, 9, 22, 12);
    const [header, payload, signature] = appJwt('123', pem, now).split('.');
    expect(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toEqual({ iss: '123', iat: now / 1000 - 60, exp: now / 1000 - 60 + 540 });
  });
});

describe('mintReadToken', () => {
  it('is null without the App', async () => {
    expect(await mintReadToken('acme/tienda')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the repo's installation for a read-only token limited to that repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ronin-app-'));
    await writeFile(join(dir, 'app.pem'), pem);
    githubApp.appId = '123';
    githubApp.privateKeyPath = join(dir, 'app.pem');
    fetchMock.mockResolvedValueOnce(answer(200, { id: 77 })).mockResolvedValueOnce(answer(201, { token: 'ghs_lectura' }));

    expect(await mintReadToken('acme/tienda')).toBe('ghs_lectura');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/tienda/installation');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.github.com/app/installations/77/access_tokens');
    expect(JSON.parse(init.body)).toEqual({ repositories: ['tienda'], permissions: READ_PERMISSIONS });
    expect(Object.values(READ_PERMISSIONS).every((p) => p === 'read')).toBe(true);
  });

  it('fails instead of falling back when the App is not installed on the repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ronin-app-'));
    await writeFile(join(dir, 'app.pem'), pem);
    githubApp.appId = '123';
    githubApp.privateKeyPath = join(dir, 'app.pem');
    fetchMock.mockResolvedValueOnce(answer(404, { message: 'Not Found' }));

    await expect(mintReadToken('acme/tienda')).rejects.toBeInstanceOf(ReadTokenError);
  });
});
