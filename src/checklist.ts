import { getIssueBody, setIssueBody } from './github.js';

// Matches lines rendered from templates/tracking-issue.md, e.g.:
// "- [ ] Slice 1: Modelo de datos — PR: _pendiente_"
// "- [x] Slice 2: Endpoint de creación — PR: #123"
const SLICE_LINE_RE = /^- \[([ x])\] Slice (\d+): (.+?) — PR: (.+)$/;

export interface Slice {
  index: number; // 0-based
  title: string;
  checked: boolean;
  prNumber: number | null;
}

function parseLine(line: string): Slice | null {
  const match = line.match(SLICE_LINE_RE);
  if (!match) return null;
  const [, checkMark, number, title, pr] = match;
  const prMatch = pr.match(/^#(\d+)$/);
  return {
    index: Number(number) - 1,
    title,
    checked: checkMark === 'x',
    prNumber: prMatch ? Number(prMatch[1]) : null,
  };
}

function renderLine(slice: Slice): string {
  const check = slice.checked ? 'x' : ' ';
  const pr = slice.prNumber ? `#${slice.prNumber}` : '_pending_';
  return `- [${check}] Slice ${slice.index + 1}: ${slice.title} — PR: ${pr}`;
}

export async function getSlices(issueNumber: number): Promise<Slice[]> {
  const body = await getIssueBody(issueNumber);
  return body.split('\n').map(parseLine).filter((s): s is Slice => s !== null);
}

// First unchecked slice, or null if every slice is checked — at that point
// the issue should already be `done` (tick.ts handles the transition).
export async function nextSliceIndex(issueNumber: number): Promise<number | null> {
  const next = (await getSlices(issueNumber)).find((s) => !s.checked);
  return next ? next.index : null;
}

export async function hasRemainingSlices(issueNumber: number): Promise<boolean> {
  return (await nextSliceIndex(issueNumber)) !== null;
}

async function updateSlice(issueNumber: number, index: number, patch: Partial<Pick<Slice, 'checked' | 'prNumber'>>): Promise<void> {
  const body = await getIssueBody(issueNumber);
  const lines = body.split('\n');
  const lineIndex = lines.findIndex((line) => parseLine(line)?.index === index);
  if (lineIndex === -1) throw new Error(`Slice ${index} not found in issue #${issueNumber} checklist`);

  const current = parseLine(lines[lineIndex])!;
  lines[lineIndex] = renderLine({ ...current, ...patch });
  await setIssueBody(issueNumber, lines.join('\n'));
}

// Idempotent: safe to call every tick for a PR that's already recorded.
// The supervisor owns this bookkeeping rather than trusting the headless
// agent's own issue edit to have landed correctly — see docs/DESIGN.md §3.1.
export async function recordSlicePr(issueNumber: number, index: number, prNumber: number): Promise<void> {
  const slices = await getSlices(issueNumber);
  const slice = slices.find((s) => s.index === index);
  if (slice?.prNumber === prNumber) return;
  await updateSlice(issueNumber, index, { prNumber });
}

export async function markSliceMerged(issueNumber: number, index: number): Promise<void> {
  await updateSlice(issueNumber, index, { checked: true });
}
