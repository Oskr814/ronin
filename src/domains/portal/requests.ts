import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import { dayIn } from '@platform/config/timezone.js';
import type { ImageUpload } from './images.js';
import type { TeamNotes } from './team-notes.js';
import { documentStore, type Counter } from '@platform/store/document-store.js';
import { DomainError } from '@platform/errors.js';

// The portal's requests (#114): what a person asked, the conversation with
// ronin, and where it stands. One folder per request under
// <PORTAL_DATA_DIR>/requests/<n>/: request.json and the images (img/).
// Numbered across every repo (P-1, P-2…), like the people see them.

export type RequestStatus =
  // ronin is reading it (a worker runs the agent).
  | 'thinking'
  // ronin asked something: it waits for the person.
  | 'asking'
  // A big request (#225): ronin left questions in a form, for the team to
  // get it with its decisions taken; it waits for the person's answers.
  | 'interviewing'
  // After the interview, ronin's summary of what it understood: the person
  // confirms it (to the team, 'big') or corrects it (back to 'thinking').
  | 'confirming'
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
  // The person approved the prototype, or ronin found a reported error's
  // small fix (#137): a dev decides before ronin makes it (#353) — deploy
  // it, make it with a review, or not do it (devDecide).
  | 'awaiting-dev'
  // A dev approved the prototype the person approved: ronin opens an issue
  // for it and makes the change in a PR, which merges on green CI once a dev
  // approves it (the one who decided, when they chose to deploy it).
  | 'approved'
  // A reported error ronin reproduced with a test that fails, whose small
  // fix turned it green (#137), once a dev approved it (#353): like an
  // approved one, ronin opens an issue for it and makes the fix in a PR.
  // The person approves nothing.
  | 'fixing'
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

// A dev's decision on a request waiting for one (#353): deploy it once its
// PR merges (ronin approves the PR as them), make it with a dev's review
// of the PR, or not do it.
export type DevDecisionKind = 'deploy' | 'review' | 'decline';

// The dev's answer, approving it, to one of what ronin left to decide
// before approving (#413, the prototype's or reproduction's team.decide):
// ronin follows it making the change.
export interface DevAnswer {
  question: string;
  answer: string;
}

// Why the person marked it prioritario, approving it: it stops their work,
// it affects customers, or it has a deadline (the date, YYYY-MM-DD).
export type PriorityImpact = 'blocks' | 'customers' | 'deadline';
export const PRIORITY_IMPACTS: PriorityImpact[] = ['blocks', 'customers', 'deadline'];

// How each impact reads, for the team and for the person.
export const IMPACT_LABEL: Record<PriorityImpact, string> = {
  blocks: 'Detiene el trabajo',
  customers: 'Afecta a clientes',
  deadline: 'Tiene fecha límite',
};

// "Tiene fecha límite: 31/10/2026", or just the impact.
export function impactLine(p: Pick<Priority, 'impact' | 'deadline'>): string {
  if (p.impact !== 'deadline' || !p.deadline) return IMPACT_LABEL[p.impact];
  const [y, m, d] = p.deadline.split('-');
  return `${IMPACT_LABEL.deadline}: ${d}/${m}/${y}`;
}

// A prioritario: what the person said and when; and, if the team took it
// away, who, why and when. It goes on as a normal request then.
export interface Priority {
  impact: PriorityImpact;
  deadline?: string;
  reason: string;
  at: string;
  removed?: { by: string; reason: string; at: string };
}

// Its PR merged, or it closed: nothing waits on anyone.
export const ENDED: RequestStatus[] = ['done', 'resolved', 'declined', 'cancelled'];

// A prioritario still in the way: marked, not taken away, not over. It goes
// first in the tablero and in the person's list.
export const activePriority = (r: Pick<PortalRequest, 'priority' | 'status'>): Priority | undefined =>
  r.priority && !r.priority.removed && !ENDED.includes(r.status) ? r.priority : undefined;

// Prioritarios first, the nearest deadline first and, without one, the
// oldest; the rest as they come.
export function byPriority<T extends { number: number; priority?: { deadline?: string } | null }>(a: T, b: T): number {
  if (Boolean(a.priority) !== Boolean(b.priority)) return a.priority ? -1 : 1;
  if (!a.priority || !b.priority) return 0;
  const da = a.priority.deadline ?? '9999';
  const db = b.priority.deadline ?? '9999';
  return da === db ? a.number - b.number : da < db ? -1 : 1;
}

// When the person can write: an answer, or an adjustment to the prototype.
export const OPEN_FOR_PERSON: RequestStatus[] = ['asking', 'answered', 'proposed'];

// While the team has it (#353), until it closes: someone of the team can
// write to the person, and the person can answer them, without it going
// back to ronin (team-conversation.ts).
export const TEAM_HELD: RequestStatus[] = ['awaiting-dev', 'approved', 'fixing', 'big'];

// Its issue is ronin's: an approved prototype, or a reported error's small
// fix (#137).
export const RONINS: RequestStatus[] = ['approved', 'fixing'];

// When the person can cancel it: while nobody took it. Approved or fixing,
// its issue is assigned to ronin; the team's, cancel.ts checks no one assigned its
// issue yet.
export const CANCELLABLE: RequestStatus[] = ['thinking', 'asking', 'answered', 'interviewing', 'confirming', 'minor', 'proposed', 'reproducing', 'awaiting-dev', 'big'];

// When someone of the team can close it from the tablero (#404), with a
// reason the person gets: while it waits on the person, ronin answered, or
// ronin reads it. With an issue, only a big one, the team's: its issue
// closes with it (team-close.ts).
export const TEAM_CLOSABLE: RequestStatus[] = ['thinking', 'asking', 'answered', 'interviewing', 'confirming', 'proposed'];

// When it expires on its own (#404, expire.ts): it waits on the person, or
// ronin answered and nothing is left to do.
export const EXPIRING: RequestStatus[] = ['asking', 'interviewing', 'confirming', 'proposed', 'answered'];

// Prototypes per request: the first and up to two adjustments. A proposal
// in words only counts as one (#409).
export const MAX_PROTOTYPES = 3;

// Proposals the person saw: prototypes, and proposals in words only.
export const proposalRounds = (r: PortalRequest) => (r.prototypes?.length ?? 0) + (r.proposals ?? 0);

// The prototype the person decides on, unless the last proposal was in
// words only (#409).
export const shownPrototype = (r: PortalRequest) => (r.verdict?.prototype === false ? undefined : r.prototypes?.at(-1));

// Tries to reproduce a reported error: the first and one more with what
// the person answered.
export const MAX_REPRODUCTIONS = 2;

export interface PortalMessage {
  id: number;
  // 'team': someone of the dev team, from the tablero (#353): `by` is their
  // GitHub login (the person sees «Equipo de desarrollo»).
  from: 'person' | 'ronin' | 'team';
  by?: string;
  // The person's answer to the team, which ronin doesn't read.
  to?: 'team';
  text: string;
  // File names under img/.
  images: string[];
  // One per image, for a prototype's ("Antes: …", "Después: …").
  captions?: string[];
  // The interview (#225): ronin's questions; the person's answers (the
  // text, then, is their optional note); ronin's summary of what it
  // understood; or the person sending it on without answering or
  // confirming it.
  questions?: InterviewQuestion[];
  answers?: InterviewAnswer[];
  understood?: Understood;
  skipped?: true;
  confirmed?: true;
  // The person's correction to that summary.
  correction?: true;
  at: string;
}

// A question of the interview (#225), as the agent wrote it: one option,
// several, or free text. Options questions may offer "Otra" (free text) and
// always offer "No sé": the team decides.
export interface InterviewQuestion {
  id: string;
  kind: 'one' | 'many' | 'text';
  text: string;
  // Why it asks, or what it's about, in a line.
  help?: string;
  options?: string[];
  other?: boolean;
  optional?: boolean;
  // For a text question: an example of an answer.
  example?: string;
}

// An answer in words, with its question, as the team reads it.
export interface InterviewAnswer {
  id: string;
  question: string;
  answer: string;
  unsure?: true;
}

// What ronin understood after the interview: each decision (topic →
// decision), what's left out, and what the team decides.
export interface Understood {
  decisions: Array<{ topic: string; decision: string }>;
  out: string[];
  team: string[];
}

export interface Prototype {
  round: number;
  // For the team: what the draft changes, technically.
  summary: string;
  // The same in parts, for the dev who decides (#406): none in older ones.
  team?: TeamNotes;
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
  // minor, proposed in words only (#409): the person decides on the
  // proposal, without a prototype.
  prototype?: false;
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
  // The same in parts, for the dev who decides (#406).
  team?: TeamNotes;
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
  // Approved as prioritario, and the team taking it away.
  | { kind: 'priority'; impact: PriorityImpact }
  | { kind: 'priority-removed'; by: string }
  // A dev's decision before ronin makes it (#353), and, deploying it, their
  // approval left on the PR ronin opened (ok: false when their token no
  // longer worked: the PR waits for an approval).
  | { kind: 'dev-decided'; decision: DevDecisionKind; by: string }
  | { kind: 'pr-approved'; number: number; by: string; ok: boolean }
  // The team and the person writing to each other while the team has it.
  | { kind: 'team-message'; by: string }
  | { kind: 'person-reply' }
  // The interview (#225): a round of questions, its answers, a summary, a
  // correction, or sending it to the team (confirmed, or without answering).
  | { kind: 'interview'; step: 'asked' | 'answered' | 'summary' | 'corrected' | 'confirmed' | 'skipped'; round: number }
  | { kind: 'mail'; to: 'person' | 'team'; subject: string; ok: boolean }
  | { kind: 'issue'; number: number; team: boolean }
  | { kind: 'pr'; number: number }
  | { kind: 'pr-closed'; number: number }
  // `by`: someone of the team closed it from the tablero (#404).
  | { kind: 'closed'; status: 'done' | 'resolved' | 'declined'; by?: string }
  | { kind: 'cancelled' }
  // Waiting on the person (#404, expire.ts): the reminder they got, and the
  // request cancelled because they didn't answer (or, answered, closed).
  | { kind: 'reminded' }
  | { kind: 'expired'; answered?: true }
  // A release that carries its change (#158): published, and how its
  // workflow ended. Only a deployed one that isn't a pre-release tells the
  // person.
  | { kind: 'deploy'; tag: string; state: 'published' | 'deployed' | 'failed'; prerelease: boolean }
  // Its PR left out of an automatic batch (#353): it doesn't apply onto the
  // last release (`base`), because of `files`, without the PRs in `needs`.
  // Noted once per base: the next batch tries it again.
  | { kind: 'deploy-skipped'; base: string; files: string[]; needs: number[] }
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
  // Small changes proposed in words only, without a prototype (#409).
  proposals?: number;
  // A reported error (#137), from the moment ronin read it as one.
  bug?: BugReport;
  // The interview (#225): rounds of questions asked, corrections to the
  // summary, and how it went to the team.
  interview?: { rounds: number; corrections: number; skipped?: true; confirmed?: true };
  // When the person approved the prototype or turned it down.
  decision?: { kind: 'approved' | 'rejected'; at: string };
  // Marked prioritario approving it.
  priority?: Priority;
  // What a dev decided while it was 'awaiting-dev' (#353): who and when, the
  // reason given not doing it, what they answered and noted approving it,
  // and — deploying it — their GitHub token,
  // sealed (dev-decision.ts), until ronin approves the PR as them.
  devDecision?: { kind: DevDecisionKind; by: string; at: string; reason?: string; answers?: DevAnswer[]; note?: string; token?: string };
  // The issue it became in the product repo (approved: for ronin; big: for
  // the team), and an approved one's PR once ronin opened it.
  issue?: { number: number; url: string };
  pr?: number;
  // The worker reading it while 'thinking', drawing the prototype while
  // 'minor', reproducing it while 'reproducing', or opening its issue once 'approved' or 'big', so the tick can
  // tell one that died (and start another).
  worker?: { pid: number; since: string };
  events?: RequestEvent[];
  // The release its change went out in, once its workflow deployed it (#158).
  deployed?: { tag: string; at: string };
  // Why the team closed it, as written when closing its PR from the
  // tablero: the same words go to the person when its issue closes.
  closeNote?: { text: string; by: string; at: string };
  // When the person answered the team, until someone of the team opens it
  // or writes back (#353): Pendientes shows «La persona respondió».
  personReplied?: string;
  createdAt: string;
  updatedAt: string;
}

// The diff that goes with it, for the team: a reported error's last
// reproduction's, or the last prototype's.
export const patchOf = (r: PortalRequest) => (r.bug ? r.bug.reproductions.at(-1)?.patch : shownPrototype(r)?.patch);

const requestsDir = () => join(config.portal.dataDir, 'requests');
export const requestDir = (n: number) => join(requestsDir(), String(n));
export const requestImagePath = (n: number, file: string) => join(requestsDir(), String(n), 'img', file);
export const prototypePatchPath = (n: number, file: string) => join(requestsDir(), String(n), 'proto', file);

export class RequestError extends DomainError {}

// request.json and counter.json, or the table portal_requests (#235,
// stage 2): each request one document, as meetings are.
const store = documentStore<PortalRequest, Counter>({
  table: 'portal_requests',
  lock: 'portalRequests',
  columns: (r) => ({ user_id: r.userId, repo: r.repo, status: r.status }),
  dir: requestsDir,
  file: 'request.json',
  emptyCounter: () => ({ last: 0 }),
  missing: () => {
    throw new RequestError('No existe ese pedido.');
  },
});

export const getRequest = store.get;
export const updateRequest = store.update;

// What a worker writes when it finishes, unless the request closed
// meanwhile — the person cancelled it, it expired, or the team closed it
// (#404): then it's left as it is, and this returns undefined.
export async function updateUnlessClosed(n: number, fn: (request: PortalRequest) => void): Promise<PortalRequest | undefined> {
  return updateRequest(n, (r) => {
    if (r.status === 'cancelled' || r.status === 'declined') return undefined;
    fn(r);
    return r;
  });
}

export const listRequests = store.list;

// The requests in the folder, as request.json has them, and writing one as
// it is with its number (the import).
export const fileRequests = store.files;
export const putRequest = store.put;

// Newest first.
export async function listRequestsOf(userId: string): Promise<PortalRequest[]> {
  return (await store.listWhere('user_id', userId, (r) => r.userId === userId)).reverse();
}

// Requests the person started today, by the team's clock (the same as
// exploration's, EXPLORE_TIMEZONE).
export async function startedToday(userId: string, now = new Date()): Promise<number> {
  const today = dayIn(now, config.exploreTimezone);
  return (await listRequestsOf(userId)).filter((r) => dayIn(new Date(r.createdAt), config.exploreTimezone) === today).length;
}

// Requests the person marked prioritario today, even if the team took it
// away: they count against portal.priorityDailyLimit.
export async function prioritizedToday(userId: string, now = new Date()): Promise<number> {
  const today = dayIn(now, config.exploreTimezone);
  return (await listRequestsOf(userId)).filter((r) => r.priority && dayIn(new Date(r.priority.at), config.exploreTimezone) === today).length;
}

// The same for everyone at once, by user id (the dashboard's accounts).
export async function startedTodayByUser(now = new Date()): Promise<Map<string, number>> {
  const today = dayIn(now, config.exploreTimezone);
  const counts = new Map<string, number>();
  for (const r of await listRequests()) if (dayIn(new Date(r.createdAt), config.exploreTimezone) === today) counts.set(r.userId, (counts.get(r.userId) ?? 0) + 1);
  return counts;
}

export async function saveImages(n: number, messageId: number, images: ImageUpload[]): Promise<string[]> {
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

// The images are written before the request is saved: none is left
// without them.
export function createRequest(input: { userId: string; repo: string; app: string; text: string; images: ImageUpload[] }, now = new Date()): Promise<PortalRequest> {
  return store.create((number) => newRequest(number, input, now));
}

async function newRequest(number: number, input: { userId: string; repo: string; app: string; text: string; images: ImageUpload[] }, now: Date): Promise<PortalRequest> {
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
  return request;
}

// The person's answer: only while the request waits on them.
export async function addPersonMessage(n: number, text: string, images: ImageUpload[], now = new Date()): Promise<PortalRequest> {
  return updateRequest(n, async (request) => {
    if (!OPEN_FOR_PERSON.includes(request.status)) throw new RequestError('Este pedido no espera una respuesta ahora.');
    if (request.status === 'proposed' && proposalRounds(request) >= MAX_PROTOTYPES) {
      throw new RequestError('Ya no quedan ajustes para este pedido: apruébalo o pásalo al equipo.');
    }
    const id = Math.max(0, ...request.messages.map((m) => m.id)) + 1;
    request.messages.push({ id, from: 'person', text: text.trim(), images: await saveImages(n, id, images), at: now.toISOString() });
    request.status = 'thinking';
    delete request.worker;
    return request;
  });
}

export const nextMessageId = (request: PortalRequest) => Math.max(0, ...request.messages.map((m) => m.id)) + 1;

export function addRoninMessage(request: PortalRequest, text: string, now = new Date(), shots?: { images: string[]; captions: string[] }): number {
  const id = nextMessageId(request);
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
