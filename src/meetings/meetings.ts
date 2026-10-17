import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../core/config.js';
import { readJson, withJson, writeJson } from '../portal/json-store.js';
import { notesHash, type Extracted } from './extract.js';

// The meetings whose notes the team uploads to the dashboard (#62). One
// folder per meeting under <MEETINGS_DATA_DIR>/meetings/<n>/: meeting.json,
// the notes as text (notes.txt) and the file as it was uploaded. Numbered
// across every repo (R-1, R-2…). One meeting is of one repo: what it says
// of another stays out.

export type MeetingStatus =
  // Uploaded: ronin hasn't read it yet.
  'pending';

export type MeetingEvent = { kind: 'uploaded'; by: string; at: string };

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
  events: MeetingEvent[];
  createdAt: string;
  updatedAt: string;
}

const meetingsDir = () => join(config.meetings.dataDir, 'meetings');
export const meetingDir = (n: number) => join(meetingsDir(), String(n));
const meetingPath = (n: number) => join(meetingDir(n), 'meeting.json');
export const notesPath = (n: number) => join(meetingDir(n), 'notes.txt');
const counterPath = () => join(meetingsDir(), 'counter.json');

// The last number, and each repo's notes by their hash.
interface Counter {
  last: number;
  hashes: Record<string, Record<string, number>>;
}
const emptyCounter = (): Counter => ({ last: 0, hashes: {} });

export class DuplicateMeeting extends Error {
  constructor(readonly number: number) {
    super(`Esas notas ya se subieron: R-${number}.`);
  }
}

export async function getMeeting(n: number): Promise<Meeting | undefined> {
  if (!Number.isInteger(n) || n < 1) return undefined;
  return readJson<Meeting | undefined>(meetingPath(n), () => undefined);
}

export async function listMeetings(): Promise<Meeting[]> {
  const { last } = await readJson(counterPath(), emptyCounter);
  const all = await Promise.all(Array.from({ length: last }, (_, i) => getMeeting(i + 1)));
  return all.filter((m): m is Meeting => Boolean(m));
}

export const readNotes = (n: number) => readFile(notesPath(n), 'utf8');

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

export async function createMeeting(input: NewMeeting, now = new Date()): Promise<Meeting> {
  const hash = notesHash(input.notes.text);
  // Numbered and checked for a repeat under the same lock: the same notes
  // uploaded twice at once get one number.
  const number = await withJson(counterPath(), emptyCounter, async (counter) => {
    const seen = counter.hashes[input.repo]?.[hash];
    // One whose files never got written (the disk failed halfway) doesn't count.
    if (seen && (await getMeeting(seen))) throw new DuplicateMeeting(seen);
    counter.last += 1;
    (counter.hashes[input.repo] ??= {})[hash] = counter.last;
    return counter.last;
  });
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
  await writeJson(meetingPath(number), meeting);
  return meeting;
}

// The uploaded file, by the name meeting.json gives it: never a path the URL makes up.
export async function readOriginal(m: Meeting): Promise<Buffer | null> {
  if (!m.source.file) return null;
  return readFile(join(meetingDir(m.number), m.source.file)).catch(() => null);
}
