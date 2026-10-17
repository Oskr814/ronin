import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
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
  // A small change: ronin proposed it and is drawing the prototype (a
  // worker brings the app up).
  | 'minor'
  // The prototype is on screen: the person approves it, asks for an
  // adjustment (back to 'thinking') or turns it down (to 'big').
  | 'proposed'
  // A reported error (#137): ronin brings the app up to reproduce it, with a
  // test that fails because of it, and tries the fix (a worker,
  // reproduce.ts).
  | 'reproducing'
  // The person approved the prototype: ronin opens an issue for it, makes
  // the change in a PR and a dev approves it before it merges.
  | 'approved'
  // Its PR merged: it goes out in the next release.
  | 'done'
  // The team's issue closed as completed…
  | 'resolved'
  // …or as not planned (or an approved one's, without its PR).
  | 'declined'
  // The person cancelled it (cancel.ts).
  | 'cancelled'
  // Too big for the portal, or turned down: the dev team takes it, in an
  // issue of its own.
  | 'big';

// When the person can write: an answer, or an adjustment to the prototype.
export const OPEN_FOR_PERSON: RequestStatus[] = ['asking', 'answered', 'proposed'];

// When the person can cancel it: while nobody took it. Approved, its issue
// is assigned to ronin; the team's, cancel.ts checks no one assigned its
// issue yet.
export const CANCELLABLE: RequestStatus[] = ['thinking', 'asking', 'answered', 'minor', 'proposed', 'reproducing', 'big'];

// Prototypes per request: the first and up to two adjustments.
export const MAX_PROTOTYPES = 3;

// Tries to reproduce a reported error: the first and one more with what
// the person answered.
export const MAX_REPRODUCTIONS = 2;

export interface PortalMessage {
  id: number;
  from: 'person' | 'ronin';
  text: string;
  // File names under img/.
  images: string[];
  // One per image, for a prototype's ("Antes: …", "Después: …").
  captions?: string[];
  at: string;
}

export interface Prototype {
  round: number;
  // For the team: what the draft changes, technically.
  summary: string;
  // The draft's diff, under proto/ (empty when the after is a mockup).
  patch?: string;
  // The message that shows it.
  messageId: number;
  at: string;
}

export interface Verdict {
  // error: a reported error, to reproduce (#137); once reproduced or not,
  // the team's ('big').
  kind: 'minor' | 'big' | 'error';
  // minor: what changes, in plain words; the prototype's instruction.
  proposal?: string;
  instruction?: string;
  // big: why, in plain words.
  reason?: string;
  // For the team: the technical summary (areas, files, risks).
  summary: string;
  at: string;
}

// The test a reproduction wrote: directly on the layer where the error is
// (the API, a function) when ronin knew where, or e2e following the
// person's steps. Red: it fails without the fix; green: it passes with it.
export interface ReproductionTest {
  kind: 'direct' | 'e2e';
  name: string;
  file?: string;
  command?: string;
  red: boolean;
  green: boolean;
  // The tail of its output, without and with the fix.
  redOutput?: string;
  greenOutput?: string;
}

// One try at reproducing a reported error (#137), in the app running from
// the base branch with disposable data.
export interface Reproduction {
  round: number;
  reproduced: boolean;
  // What ronin did in the app, step by step (for the team).
  steps: string[];
  test?: ReproductionTest;
  // The fix ronin tried, when the cause was clear: small (a few hours'
  // work, its test green) or big (it left the fix out, `reason` says why).
  fix?: 'small' | 'big';
  reason?: string;
  // For the team: the cause, the files involved and the risks; or, not
  // reproduced, what ronin suspects.
  summary: string;
  // Its diff, under proto/: the test, and the fix when it made one.
  patch?: string;
  // The message that told the person.
  messageId: number;
  at: string;
}

// A reported error: the steps to reproduce it as ronin understood them, and
// its tries.
export interface BugReport {
  steps: string;
  reproductions: Reproduction[];
}

// What happened to a request besides its messages (#132): what the
// dashboard shows as its activity. Only appended to, oldest first.
export type RequestEvent = { at: string } & (
  // A worker started on it: by the server when the person wrote or
  // decided, or by the tick when the one before died.
  | { kind: 'worker'; by: 'server' | 'tick'; pid: number }
  // Something failed: reading it, a prototype attempt, opening its issue,
  // or the worker itself. The request goes on (asks again, goes to the
  // team, or the tick launches another worker).
  | { kind: 'failed'; step: 'classify' | 'prototype' | 'reproduce' | 'worker'; error: string }
  // The prototype (or the reproduction) waited for the repo's turn: they
  // share it, each brings the app up.
  | { kind: 'waiting'; for: 'prototype-lock' }
  // ronin read it and decided (a question or an answer are its messages).
  | { kind: 'classified'; verdict: 'minor' | 'big' | 'error' }
  // A try at reproducing a reported error (#137).
  | { kind: 'reproduced'; round: number; reproduced: boolean; test: 'red' | 'green' | 'none' }
  | { kind: 'decided'; decision: 'approved' | 'rejected' }
  | { kind: 'mail'; to: 'person' | 'team'; subject: string; ok: boolean }
  | { kind: 'issue'; number: number; team: boolean }
  | { kind: 'pr'; number: number }
  | { kind: 'pr-closed'; number: number }
  | { kind: 'closed'; status: 'done' | 'resolved' | 'declined' }
  | { kind: 'cancelled' }
);

// Enough for every round a request can go through, with room for the
// tick's relaunches: past it, the oldest are dropped.
export const MAX_EVENTS = 200;

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
  prototypes?: Prototype[];
  // A reported error (#137), from the moment ronin read it as one.
  bug?: BugReport;
  // When the person approved the prototype or turned it down.
  decision?: { kind: 'approved' | 'rejected'; at: string };
  // The issue it became in the product repo (approved: for ronin; big: for
  // the team), and an approved one's PR once ronin opened it.
  issue?: { number: number; url: string };
  pr?: number;
  // The worker reading it while 'thinking', drawing the prototype while
  // 'minor', reproducing it while 'reproducing', or opening its issue once 'approved' or 'big', so the tick can
  // tell one that died (and start another).
  worker?: { pid: number; since: string };
  events?: RequestEvent[];
  createdAt: string;
  updatedAt: string;
}

// The diff that goes with it, for the team: a reported error's last
// reproduction's, or the last prototype's.
export const patchOf = (r: PortalRequest) => (r.bug ? r.bug.reproductions.at(-1)?.patch : r.prototypes?.at(-1)?.patch);

const requestsDir = () => join(config.portal.dataDir, 'requests');
const requestPath = (n: number) => join(requestsDir(), String(n), 'request.json');
export const requestDir = (n: number) => join(requestsDir(), String(n));
export const requestImagePath = (n: number, file: string) => join(requestsDir(), String(n), 'img', file);
export const prototypePatchPath = (n: number, file: string) => join(requestsDir(), String(n), 'proto', file);
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

// What a worker writes when it finishes, unless the person cancelled the
// request meanwhile: then it's left as it is, and this returns undefined.
export async function updateUnlessCancelled(n: number, fn: (request: PortalRequest) => void): Promise<PortalRequest | undefined> {
  return updateRequest(n, (r) => {
    if (r.status === 'cancelled') return undefined;
    fn(r);
    return r;
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
    if (request.status === 'proposed' && (request.prototypes?.length ?? 0) >= MAX_PROTOTYPES) {
      throw new RequestError('Ya no quedan ajustes para este pedido: apruébalo o pásalo al equipo.');
    }
    const id = Math.max(0, ...request.messages.map((m) => m.id)) + 1;
    request.messages.push({ id, from: 'person', text: text.trim(), images: await saveImages(n, id, images), at: now.toISOString() });
    request.status = 'thinking';
    delete request.worker;
    return request;
  });
}

export function addRoninMessage(request: PortalRequest, text: string, now = new Date(), shots?: { images: string[]; captions: string[] }): number {
  const id = Math.max(0, ...request.messages.map((m) => m.id)) + 1;
  request.messages.push({ id, from: 'ronin', text, images: shots?.images ?? [], ...(shots ? { captions: shots.captions } : {}), at: now.toISOString() });
  return id;
}

// The person's note when turning a prototype down, if they left one.
export function addPersonNote(request: PortalRequest, text: string, now = new Date()): void {
  const id = Math.max(0, ...request.messages.map((m) => m.id)) + 1;
  request.messages.push({ id, from: 'person', text, images: [], at: now.toISOString() });
}

// Distributes over the union, so each kind keeps its own fields.
type EventInput = RequestEvent extends infer E ? (E extends RequestEvent ? Omit<E, 'at'> : never) : never;

export function addEvent(request: PortalRequest, event: EventInput, now = new Date()): void {
  const events = (request.events ??= []);
  events.push({ ...event, at: now.toISOString() } as RequestEvent);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

// An event on its own, outside any other change to the request: never
// throws, a lost line of activity never holds a request back.
export async function noteEvent(n: number, event: EventInput, now = new Date()): Promise<void> {
  try {
    await updateRequest(n, (r) => addEvent(r, event, now));
  } catch (error) {
    log.error(`portal: no se pudo anotar un evento del pedido P-${n}`, error);
  }
}

// The first line of an error, short, for an event.
export const errorLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300);
