import { describe, it, expect } from 'vitest';
import { redact } from './logger.js';

const env = { RONIN_GITHUB_TOKEN: 'github_pat_11ABCDEFG0123456789_abcdefghij', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', WEBHOOK_SECRET: 'e3b0c44298fc1c14', NODE_ENV: 'production', RUNNER_ID: 'ronin-agent' };

describe('redact', () => {
  it("replaces the runner's own secrets by value, naming the variable", () => {
    expect(redact('gh falló con github_pat_11ABCDEFG0123456789_abcdefghij en la URL', env)).toBe('gh falló con [redacted:RONIN_GITHUB_TOKEN] en la URL');
    expect(redact('smtp login abcd efgh ijkl mnop', env)).toBe('smtp login [redacted:GMAIL_APP_PASSWORD]');
  });

  it('leaves alone variables that are not secrets, however long', () => {
    expect(redact('runner ronin-agent en production', env)).toBe('runner ronin-agent en production');
  });

  it('redacts a JWT, also one cut short by the truncated agent output (2026-10-16 log)', () => {
    expect(redact("tool error: Exit code 1 {'accessToken': 'eyJhbGciOiJIUzUxMiIsInR", {})).not.toContain('eyJhbGciOiJIUzUxMiIsInR');
    expect(redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl listo', {})).toBe('token [redacted] listo');
  });

  it('redacts GitHub tokens and Authorization headers', () => {
    expect(redact('GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', {})).not.toContain('ghp_');
    expect(redact('curl -H "Authorization: Bearer abc.def-123456789" https://x', {})).not.toContain('abc.def-123456789');
  });

  it('keeps the key of a sensitive key-value pair and hides only the value', () => {
    expect(redact(`{"accessToken": "xyz123456", "user": "admin"}`, {})).toBe(`{"accessToken": "[redacted]", "user": "admin"}`);
    expect(redact('login con password=Sup3rS3cret!', {})).toBe('login con password=[redacted]');
    expect(redact("{'api_key': 'k-123456789'}", {})).toBe("{'api_key': '[redacted]'}");
  });

  it('redacts credentials in a URL, keeping the host', () => {
    expect(redact('postgres://root:hunter22@db:5432/app', {})).toBe('postgres://root:[redacted]@db:5432/app');
  });

  it('keeps a JSON metric line valid JSON', () => {
    const out = redact(JSON.stringify({ event: 'x', token: 'abcdefgh123', n: 3 }), {});
    expect(JSON.parse(out)).toEqual({ event: 'x', token: '[redacted]', n: 3 });
  });

  // #370: the GitHub operations of a tick_complete, one of them named
  // mintReadToken, came out with "[redacted]" where the object opened.
  it('keeps a metric valid JSON when a sensitive-sounding key holds an object or a list, still redacting inside it', () => {
    const line = JSON.stringify({ event: 'tick_complete', githubOps: { mintReadToken: { ms: 611, count: 2 }, getIssueBody: { ms: 5, count: 1 } }, tokens: [1, 2], auth: { accessToken: 'xyz123456789' } });
    expect(JSON.parse(redact(line, {}))).toEqual({ event: 'tick_complete', githubOps: { mintReadToken: { ms: 611, count: 2 }, getIssueBody: { ms: 5, count: 1 } }, tokens: [1, 2], auth: { accessToken: '[redacted]' } });
  });

  it('does not touch ordinary log lines that merely mention tokens', () => {
    const lines = [
      'public | invite_tokens | table | root',
      '{"event":"tick_complete","durationMs":39263,"agentRuns":0,"repo":"redmotos/shoppingcart"}',
      'issue #879 slice 1 PR #881 (bottom): checks pendientes, esperando',
      '{"usage":{"input_tokens":1234,"output_tokens":56}}',
    ];
    for (const l of lines) expect(redact(l, {})).toBe(l);
  });
});
