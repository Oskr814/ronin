import { describe, it, expect, vi, beforeEach } from 'vitest';

const bodies = new Map<number, string>();
const setIssueBody = vi.fn(async (issueNumber: number, body: string) => {
  bodies.set(issueNumber, body);
});

vi.mock('../core/github.js', () => ({
  getIssueBody: vi.fn(async (issueNumber: number) => bodies.get(issueNumber) ?? ''),
  setIssueBody: (...args: [number, string]) => setIssueBody(...args),
}));

import { nextSlice, nextUnstartedSlice, hasRemainingSlices, recordSlicePr, markSliceMerged, seedSingleSlice } from './checklist.js';

const SAMPLE_BODY = [
  '## Slices',
  '',
  '- [x] Slice 1: Catálogo de permisos — PR: #229',
  '- [ ] Slice 2: Tabla de citas — PR: #230',
  '- [ ] Slice 3: Lectura — PR: _pending_',
].join('\n');

beforeEach(() => {
  bodies.clear();
  bodies.set(228, SAMPLE_BODY);
  vi.clearAllMocks();
});

describe('nextSlice (unchanged)', () => {
  it('returns the first unchecked slice regardless of PR state', async () => {
    const slice = await nextSlice(228);
    expect(slice).toMatchObject({ index: 1, title: 'Tabla de citas' });
  });
});

describe('hasRemainingSlices (unchanged)', () => {
  it('is true while any slice is unchecked', async () => {
    expect(await hasRemainingSlices(228)).toBe(true);
  });

  it('is false once every slice is checked', async () => {
    bodies.set(228, SAMPLE_BODY.replaceAll('[ ]', '[x]').replace('_pending_', '#231'));
    expect(await hasRemainingSlices(228)).toBe(false);
  });
});

describe('nextUnstartedSlice', () => {
  it('returns the first slice with no PR recorded yet, regardless of merge state', async () => {
    const slice = await nextUnstartedSlice(228);
    expect(slice).toMatchObject({ index: 2, title: 'Lectura' });
  });

  it('returns null once every slice has a PR, merged or not', async () => {
    bodies.set(228, SAMPLE_BODY.replace('_pending_', '#231'));
    expect(await nextUnstartedSlice(228)).toBeNull();
  });
});

describe('recordSlicePr / markSliceMerged', () => {
  it('recordSlicePr writes the PR number for a pending slice', async () => {
    await recordSlicePr(228, 2, 231);
    expect(bodies.get(228)).toContain('- [ ] Slice 3: Lectura — PR: #231');
  });

  it('markSliceMerged checks off the slice', async () => {
    await markSliceMerged(228, 1);
    expect(bodies.get(228)).toContain('- [x] Slice 2: Tabla de citas — PR: #230');
  });
});

describe('seedSingleSlice', () => {
  it('appends a single-slice "## Slices" section to an existing body', async () => {
    bodies.set(500, '## Bug report\n\nSteps to reproduce...');

    await seedSingleSlice(500, 'Fix — Login redirects to 404');

    expect(bodies.get(500)).toBe(
      '## Bug report\n\nSteps to reproduce...\n\n## Slices\n\n- [ ] Slice 1: Fix — Login redirects to 404 — PR: _pending_\n',
    );
  });

  it('is idempotent — does nothing once a Slices section already exists', async () => {
    bodies.set(228, SAMPLE_BODY);

    await seedSingleSlice(228, 'irrelevant');

    expect(bodies.get(228)).toBe(SAMPLE_BODY);
    expect(setIssueBody).not.toHaveBeenCalled();
  });
});
