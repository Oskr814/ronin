import { readFile } from 'node:fs/promises';
import { timedGithub } from '../timing.js';
import { GITHUB_API } from './rest.js';

// `gh api` without a process per call (#370): the same arguments, sent with
// fetch. Each `gh` spent ~250–300 ms starting up and opening its own
// connection; fetch keeps one open to api.github.com for the whole process.
// Only what ronin's calls use is understood (apiRequestOf); anything else —
// --jq, --paginate, a field read from a file — returns null and goes
// through gh as before.

export interface ApiRequest {
  method: string;
  // From the API's root, or a whole URL (a page's next, from Link).
  path: string;
  headers: Record<string, string>;
  // A JSON body, or the file whose contents are it (--input).
  body?: unknown;
  inputFile?: string;
}

type Field = string | number | boolean | null;

// -F's values as gh types them: true, false, null and integers; the rest
// stays a string. One read from a file (@path) isn't understood.
function typedField(value: string): Field | undefined {
  if (value.startsWith('@')) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

// The request `gh api <args>` makes, or null for what isn't understood.
export function apiRequestOf(args: string[]): ApiRequest | null {
  if (args[0] !== 'api') return null;
  let endpoint: string | undefined;
  let method: string | undefined;
  let inputFile: string | undefined;
  const headers: Record<string, string> = {};
  const fields: Record<string, Field | Field[]> = {};
  const addField = (pair: string, typed: boolean): boolean => {
    const at = pair.indexOf('=');
    if (at <= 0) return false;
    const key = pair.slice(0, at);
    const value = typed ? typedField(pair.slice(at + 1)) : pair.slice(at + 1);
    if (value === undefined) return false;
    if (key.endsWith('[]')) {
      const list = fields[key.slice(0, -2)];
      fields[key.slice(0, -2)] = Array.isArray(list) ? [...list, value] : [value];
    } else if (key.includes('[')) {
      return false;
    } else {
      fields[key] = value;
    }
    return true;
  };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const value = args[i + 1];
    switch (arg) {
      case '-X': case '--method': if (value === undefined) return null; method = value.toUpperCase(); i++; break;
      case '-f': case '--raw-field': if (value === undefined || !addField(value, false)) return null; i++; break;
      case '-F': case '--field': if (value === undefined || !addField(value, true)) return null; i++; break;
      case '--input': if (value === undefined) return null; inputFile = value; i++; break;
      case '-H': case '--header': {
        const at = value?.indexOf(':') ?? -1;
        if (!value || at <= 0) return null;
        headers[value.slice(0, at).trim()] = value.slice(at + 1).trim();
        i++;
        break;
      }
      default:
        if (arg.startsWith('-') || endpoint !== undefined) return null;
        endpoint = arg;
    }
  }
  if (endpoint === undefined) return null;
  if (endpoint === 'graphql') {
    const { query, ...variables } = fields;
    if (typeof query !== 'string' || inputFile) return null;
    return { method: method ?? 'POST', path: '/graphql', headers, body: { query, variables } };
  }
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const hasFields = Object.keys(fields).length > 0;
  const verb = method ?? (hasFields || inputFile ? 'POST' : 'GET');
  // Like gh: a GET's fields, and the fields next to an --input, go in the query.
  if (verb === 'GET' || inputFile) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      for (const v of Array.isArray(value) ? value : [value]) query.append(Array.isArray(value) ? `${key}[]` : key, String(v));
    }
    const qs = query.toString();
    return { method: verb, path: qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path, headers, ...(inputFile ? { inputFile } : {}) };
  }
  return { method: verb, path, headers, ...(hasFields ? { body: fields } : {}) };
}

// A failed call, worded like gh's — "Not Found (HTTP 404)", "GraphQL: …" —
// since that's what the callers read in it (isTransientGhError, a 404 that
// means "no such issue").
export class GithubApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GithubApiError';
  }
}

// The next page's URL in a Link header, if there is one.
export function nextPageOf(link: string | null): string | null {
  return link?.split(',').map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1]).find(Boolean) ?? null;
}

// GitHub's own words for a failed answer: its message, and for a 422 what
// failed in it.
function messageOf(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string; code?: string; field?: string } | string> };
    const details = (body.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message ?? [e.field, e.code].filter(Boolean).join(' '))).filter(Boolean);
    return [body.message ?? text.trim(), ...details].join('; ');
  } catch {
    return text.trim().slice(0, 300);
  }
}

// A network failure, with its code where the transient ones are told apart
// (ECONNRESET, ETIMEDOUT…).
function networkError(request: ApiRequest, error: unknown): GithubApiError {
  const e = error as Error & { cause?: { code?: string; message?: string } };
  const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'ETIMEDOUT' : e.cause?.code ?? e.cause?.message ?? '';
  return new GithubApiError(`gh api ${request.method} ${request.path}: ${e.message}${code ? ` (${code})` : ''}`);
}

// A big PR's files with their patches, or a long paginated read, can take a
// while; gh had no limit at all.
const TIMEOUT_MS = 60_000;

// Sends it; the body as text, as gh printed it, and the next page if any.
export async function callGithubApi(request: ApiRequest, token: string, operation: string): Promise<{ text: string; next: string | null }> {
  const body = request.inputFile !== undefined ? await readFile(request.inputFile, 'utf8') : request.body !== undefined ? JSON.stringify(request.body) : undefined;
  const url = request.path.startsWith('https://') ? request.path : `${GITHUB_API}${request.path}`;
  return timedGithub(async () => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ronin',
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...request.headers,
        },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw networkError(request, error);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw networkError(request, error);
    }
    if (!response.ok) throw new GithubApiError(`gh api ${request.method} ${request.path}: ${messageOf(text)} (HTTP ${response.status})`, response.status);
    if (request.path === '/graphql') {
      const errors = (JSON.parse(text) as { errors?: Array<{ message: string }> }).errors;
      if (errors?.length) throw new GithubApiError(`gh api graphql: GraphQL: ${errors.map((e) => e.message).join(', ')}`);
    }
    return { text, next: nextPageOf(response.headers.get('link')) };
  }, operation);
}
