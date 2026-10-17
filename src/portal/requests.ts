import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../core/config.js';
import { dayIn } from '../core/timezone.js';
import type { ImageUpload } from './images.js';
import { readJson, withJson, writeJson } from './json-store.js';

// The portal's requests (#114): what a person asked, the conversation with
// ronin, and where it stands. One folder per request under
// <PORTAL_DATA_DIR>/requests/<n>/: request.json and the images (img/).
// Numbered across every repo (P-1, P-2…), like the people see them.

export type RequestStatus =
  // ronin is reading it (a worker runs the agent).
  | 'thinking'
  // ronin asked something: it waits for the person.
  | 'asking'
  // ronin answered without a change to make (a question about the app): the
  // person can write again.
  | 'answered'
  // A small change: ronin proposed it, the prototype comes next.
  | 'minor'
  // Too big for the portal: the dev team takes it.
  | 'big';

export const OPEN_FOR_PERSON: RequestStatus[] = ['asking', 'answered'];

export interface PortalMessage {
  id: number;
  from: 'person' | 'ronin';
  text: string;
  // File names under img/.
  images: string[];
  at: string;
}

export interface Verdict {
  kind: 'minor' | 'big';
  // minor: what changes, in plain words; the prototype's instruction.
  proposal?: string;
  instruction?: string;
  // big: why, in plain words.
  reason?: string;
  // For the team: the technical summary (areas, files, risks).
  summary: string;
  at: string;
}

export interface PortalRequest {
  number: number;
  userId: string;
  repo: string;
  app: string;
  title: string;
  status: RequestStatus;
  messages: PortalMessage[];
  // How many times ronin asked something, to stop asking at some point.
  questions: number;
  verdict?: Verdict;
  // The worker reading it while 'thinking', so the tick can tell one that
  // died (and start another).
  worker?: { pid: number; since: string };
  createdAt: string;
  updatedAt: string;
}

const requestsDir = () => join(config.portal.dataDir, 'requests');
const requestPath = (n: number) => join(requestsDir(), String(n), 'request.json');
export const requestImagePath = (n: number, file: string) => join(requestsDir(), String(n), 'img', file);
const counterPath = () => join(requestsDir(), 'counter.json');

export class RequestError extends Error {}

const missing = (): PortalRequest => {
  throw new RequestError('No existe ese pedido.');
};

export async function getRequest(n: number): Promise<PortalRequest | undefined> {
  if (!Number.isInteger(n) || n < 1) return undefined;
  return readJson<PortalRequest | undefined>(requestPath(n), () => undefined);
}

export function updateRequest<R>(n: number, fn: (request: PortalRequest) => R | Promise<R>): Promise<R> {
  return withJson(requestPath(n), missing, async (request) => {
    const result = await fn(request);
    request.updatedAt = new Date().toISOString();
    return result;
  });
}

export async function listRequests(): Promise<PortalRequest[]> {
  const { last } = await readJson(counterPath(), () => ({ last: 0 }));
  const all = await Promise.all(Array.from({ length: last }, (_, i) => getRequest(i + 1)));
  return all.filter((r): r is PortalRequest => Boolean(r));
}

export async function listRequestsOf(userId: string): Promise<PortalRequest[]> {
  return (await listRequests()).filter((r) => r.userId === userId).sort((a, b) => b.number - a.number);
}

// Requests the person started today, by the team's clock (the same as
// exploration's, EXPLORE_TIMEZONE).
export async function startedToday(userId: string, now = new Date()): Promise<number> {
  const today = dayIn(now, config.exploreTimezone);
  return (await listRequestsOf(userId)).filter((r) => dayIn(new Date(r.createdAt), config.exploreTimezone) === today).length;
}

async function saveImages(n: number, messageId: number, images: ImageUpload[]): Promise<string[]> {
  const names: string[] = [];
  for (const [i, image] of images.entries()) {
    const name = `${messageId}-${i + 1}.${image.ext}`;
    await mkdir(dirname(requestImagePath(n, name)), { recursive: true, mode: 0o700 });
    await writeFile(requestImagePath(n, name), image.data, { mode: 0o600 });
    names.push(name);
  }
  return names;
}

export const TITLE_MAX = 80;
export const TEXT_MAX = 4000;

const firstLine = (text: string) => {
  const line = text.trim().split('\n')[0].trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

export async function createRequest(input: { userId: string; repo: string; app: string; text: string; images: ImageUpload[] }, now = new Date()): Promise<PortalRequest> {
  const number = await withJson(counterPath(), () => ({ last: 0 }), (counter) => ++counter.last);
  const at = now.toISOString();
  const images = await saveImages(number, 1, input.images);
  const request: PortalRequest = {
    number,
    userId: input.userId,
    repo: input.repo,
    app: input.app,
    title: firstLine(input.text) || 'Pedido con imágenes',
    status: 'thinking',
    messages: [{ id: 1, from: 'person', text: input.text.trim(), images, at }],
    questions: 0,
    createdAt: at,
    updatedAt: at,
  };
  await writeJson(requestPath(number), request);
  return request;
}

// The person's answer: only while the request waits on them.
export async function addPersonMessage(n: number, text: string, images: ImageUpload[], now = new Date()): Promise<PortalRequest> {
  return updateRequest(n, async (request) => {
    if (!OPEN_FOR_PERSON.includes(request.status)) throw new RequestError('Este pedido no espera una respuesta ahora.');
    const id = Math.max(0, ...request.messages.map((m) => m.id)) + 1;
    request.messages.push({ id, from: 'person', text: text.trim(), images: await saveImages(n, id, images), at: now.toISOString() });
    request.status = 'thinking';
    delete request.worker;
    return request;
  });
}

export function addRoninMessage(request: PortalRequest, text: string, now = new Date()): void {
  const id = Math.max(0, ...request.messages.map((m) => m.id)) + 1;
  request.messages.push({ id, from: 'ronin', text, images: [], at: now.toISOString() });
}
