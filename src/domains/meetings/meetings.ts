import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@platform/config/config.js';
import { documentStore } from '@platform/store/document-store.js';
import { notesHash, type Extracted } from './extract.js';
import { DomainError } from '@platform/errors.js';

// The meetings whose notes the team uploads to the dashboard (#62). One
// folder per meeting under <MEETINGS_DATA_DIR>/meetings/<n>/: meeting.json,
// the notes as text (notes.txt) and the file as it was uploaded. Numbered
// across every repo (R-1, R-2…). One meeting is of one repo: what it says
// of another stays out.
//
// With DATABASE_URL (#235, stage 2), meeting.json and counter.json are the
// table meetings instead; the notes and the file stay in the folder.

export type MeetingStatus =
  // Uploaded: its worker reads it as soon as there's a slot.
  | 'pending'
  // ronin is reading it (read.ts).
  | 'reading'
  // ronin proposed work out of it: someone reviews it.
  | 'review'
  // Nothing to do came out of it: ronin proposed nothing.
  | 'empty'
  // The reading failed: someone can ask for it again.
  | 'failed'
  // Someone approved what they chose of it, and all of that was created.
  | 'done'
  // Someone set all of it aside: nothing was created.
  | 'discarded';

// Where a proposed issue goes in Linear: the team's current cycle or the next one.
export type ProposedCycle = 'current' | 'next';

// What ronin proposes out of a meeting (proposals.ts checks what its agent
// wrote). `cites`: the lines of the notes that justify it, numbered from 1
// (noteLines).
export interface ProposedIssue {
  id: string;
  title: string;
  body: string;
  why: string;
  cites: number[];
  // An existing Linear project, by name; an issue of a new project goes inside it instead.
  project?: string;
  cycle?: ProposedCycle;
}

export interface ProposedProject {
  id: string;
  name: string;
  description: string;
  why: string;
  cites: number[];
  // A person of the Linear team, by name.
  lead?: string;
  issues: ProposedIssue[];
}

// On an issue that's already open: what the meeting adds to it.
export interface ProposedComment {
  id: string;
  issue: number;
  issueTitle: string;
  body: string;
  why: string;
  cites: number[];
  cycle?: ProposedCycle;
}

// What was talked about and asks for no new work, and why.
export interface Discarded {
  topic: string;
  why: string;
  cites: number[];
}

export interface Proposals {
  // What the meeting was about, in ronin's words.
  summary: string;
  projects: ProposedProject[];
  issues: ProposedIssue[];
  comments: ProposedComment[];
  discarded: Discarded[];
  at: string;
}

export type MeetingEvent = { at: string } & (
  | { kind: 'uploaded'; by: string }
  // Who launched its worker: the server on upload or retry, the tick when the one before died.
  | { kind: 'worker'; by: 'server' | 'tick'; pid: number }
  | { kind: 'retried'; by: string }
  | { kind: 'read'; projects: number; issues: number; comments: number; discarded: number }
  | { kind: 'failed'; error: string }
  | { kind: 'mail'; ok: boolean }
  // What someone approved: how much was created and how much failed.
  | { kind: 'approved'; by: string; created: number; failed: number }
  | { kind: 'discarded'; by: string }
);

// What became of a proposal someone approved (meetings/approve.ts),
// by its id: what was created, or why it couldn't be. One created is never
// created again.
export type ProposalOutcome = { ok: true; url: string; number?: number; projectId?: string } | { ok: false; error: string };
export type ProposalResult = { by: string; at: string } & ProposalOutcome;

export interface MeetingSource {
  kind: Extracted['kind'] | 'pasted';
  // The uploaded file's name, as it came.
  name?: string;
  bytes?: number;
  pages?: number;
  // The file kept under the meeting's folder.
  file?: string;
}

export interface Meeting {
  number: number;
  repo: string;
  title: string;
  // When it was, if the person said.
  at?: string;
  // The meeting's or its recording's.
  link?: string;
  // The GitHub login of who uploaded it.
  by: string;
  source: MeetingSource;
  chars: number;
  // Of the notes' text (notesHash): the same notes aren't uploaded twice to a repo.
  hash: string;
  status: MeetingStatus;
  // The worker reading it, so the tick can tell when it died.
  worker?: { pid: number; since: string };
  proposals?: Proposals;
  results?: Record<string, ProposalResult>;
  events: MeetingEvent[];
  createdAt: string;
  updatedAt: string;
}

const meetingsDir = () => join(config.meetings.dataDir, 'meetings');
export const meetingDir = (n: number) => join(meetingsDir(), String(n));
export const notesPath = (n: number) => join(meetingDir(n), 'notes.txt');

// The last number, and each repo's notes by their hash.
interface Counter {
  last: number;
  hashes: Record<string, Record<string, number>>;
}
const emptyCounter = (): Counter => ({ last: 0, hashes: {} });

export class DuplicateMeeting extends DomainError {
  constructor(readonly number: number) {
    super(`Esas notas ya se subieron: R-${number}.`, { status: 409, details: { number } });
  }
}

class MissingMeeting extends Error {}

// meeting.json and counter.json, or the table meetings (#235, stage 2). A
// new number and its check for repeated notes take turns under one lock.
const store = documentStore<Meeting, Counter>({
  table: 'meetings',
  lock: 'meetings',
  columns: (m) => ({ repo: m.repo, hash: m.hash, status: m.status }),
  dir: meetingsDir,
  file: 'meeting.json',
  emptyCounter,
  missing: () => {
    throw new MissingMeeting('No existe esa reunión.');
  },
});

export const getMeeting = store.get;
export const listMeetings = store.list;

export const readNotes = (n: number) => readFile(notesPath(n), 'utf8');

// The notes' lines with text, numbered from 1: what ronin cites them by.
export const noteLines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

export const updateMeeting = store.update;

// Distributive, so each event kind keeps its own fields.
type NewEvent = MeetingEvent extends infer E ? (E extends MeetingEvent ? Omit<E, 'at'> : never) : never;

export function addEvent(meeting: Meeting, event: NewEvent, now = new Date()): void {
  meeting.events.push({ ...event, at: now.toISOString() } as MeetingEvent);
}

export const noteEvent = (n: number, event: NewEvent) => updateMeeting(n, (m) => addEvent(m, event));

// An error's first line, short enough for the activity.
export const errorLine = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0].slice(0, 300);

export const ORIGINAL_EXT: Record<Extracted['kind'], string> = { pdf: 'pdf', docx: 'docx', text: 'txt' };

export const TITLE_MAX = 120;

// The person's, the file's name without its extension, or the notes' first line.
export function meetingTitle(title: string | undefined, fileName: string | undefined, text: string): string {
  const pick = [title, fileName?.replace(/\.[^.]+$/, ''), text.split('\n').find((line) => line.trim())]
    .map((s) => (s ?? '').replace(/\s+/g, ' ').trim())
    .find(Boolean) ?? 'Reunión';
  return pick.length > TITLE_MAX ? `${pick.slice(0, TITLE_MAX - 1)}…` : pick;
}

export interface NewMeeting {
  repo: string;
  by: string;
  title?: string;
  at?: string;
  link?: string;
  notes: Extracted;
  // The file, when it came as one.
  file?: { name: string; data: Buffer };
}

// Numbered and checked for a repeat under the same lock: the same notes
// uploaded twice at once get one number. The notes are written to their
// folder before the meeting is saved: if the disk fails, no meeting is left
// without its notes.
export function createMeeting(input: NewMeeting, now = new Date()): Promise<Meeting> {
  const hash = notesHash(input.notes.text);
  return store.create((number) => writeMeetingFiles(number, hash, input, now), {
    db: async (trx) => {
      const seen = await trx.selectFrom('meetings').select('number').where('repo', '=', input.repo).where('hash', '=', hash).executeTakeFirst();
      if (seen) throw new DuplicateMeeting(seen.number);
    },
    files: async (counter, next) => {
      const seen = counter.hashes[input.repo]?.[hash];
      // One whose files never got written (the disk failed halfway) doesn't count.
      if (seen && (await getMeeting(seen))) throw new DuplicateMeeting(seen);
      (counter.hashes[input.repo] ??= {})[hash] = next;
    },
  });
}

// For the import (scripts/db-import-meetings.ts): writes one as it is, and
// the meetings in the folder as meeting.json has them.
export const putMeeting = store.put;
export const fileMeetings = store.files;

// Its folder, with the notes and the file, and the record that goes with them.
async function writeMeetingFiles(number: number, hash: string, input: NewMeeting, now: Date): Promise<Meeting> {
  const at = now.toISOString();
  await mkdir(meetingDir(number), { recursive: true, mode: 0o700 });
  await writeFile(notesPath(number), input.notes.text, { mode: 0o600 });
  let file: string | undefined;
  if (input.file) {
    file = `original.${ORIGINAL_EXT[input.notes.kind]}`;
    await writeFile(join(meetingDir(number), file), input.file.data, { mode: 0o600 });
  }
  const meeting: Meeting = {
    number,
    repo: input.repo,
    title: meetingTitle(input.title, input.file?.name, input.notes.text),
    ...(input.at ? { at: input.at } : {}),
    ...(input.link ? { link: input.link } : {}),
    by: input.by,
    source: input.file
      ? { kind: input.notes.kind, name: input.file.name, bytes: input.file.data.length, ...(input.notes.pages ? { pages: input.notes.pages } : {}), file }
      : { kind: 'pasted' },
    chars: input.notes.text.length,
    hash,
    status: 'pending',
    events: [{ kind: 'uploaded', by: input.by, at }],
    createdAt: at,
    updatedAt: at,
  };
  return meeting;
}

// The uploaded file, by the name meeting.json gives it: never a path the URL makes up.
export async function readOriginal(m: Meeting): Promise<Buffer | null> {
  if (!m.source.file) return null;
  return readFile(join(meetingDir(m.number), m.source.file)).catch(() => null);
}
