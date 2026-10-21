import { describe, expect, it } from 'vitest';
import type { Question } from './api.js';
import { answered, missing, payload, progress } from './Interview.js';

const qs = [
  { id: 'quien', kind: 'one', text: '¿Quién?', options: ['A', 'B'], other: true },
  { id: 'formato', kind: 'many', text: '¿Formato?', options: ['X', 'Y', 'Z'] },
  { id: 'nota', kind: 'text', text: '¿Algo más?', optional: true },
] as Question[];

describe('the interview', () => {
  it('counts a question answered when it has an option, its other answer written, a text, or "No sé"', () => {
    expect(answered(qs[0], { picked: '1' })).toBe(true);
    expect(answered(qs[0], { picked: 'otra' })).toBe(false);
    expect(answered(qs[0], { picked: 'otra', other: 'C' })).toBe(true);
    expect(answered(qs[1], { picked: [] })).toBe(false);
    expect(answered(qs[1], { unsure: true })).toBe(true);
    expect(answered(qs[2], { text: '  ' })).toBe(false);
  });

  it('counts only the required ones, and names the first one missing', () => {
    const answers = { quien: { picked: '0' } };
    expect(progress(qs, answers)).toEqual([1, 2]);
    expect(missing(qs, answers)?.id).toBe('formato');
    expect(missing(qs, { ...answers, formato: { unsure: true } })).toBeUndefined();
  });

  it('sends the options as their indexes, the other answer apart, and only what was answered', () => {
    expect(payload(qs, { quien: { picked: 'otra', other: 'C' }, formato: { picked: ['0', '2'] } })).toEqual([
      { id: 'quien', choices: [], other: 'C' },
      { id: 'formato', choices: [0, 2] },
    ]);
    expect(payload(qs, { formato: { unsure: true }, nota: { text: 'x' } })).toEqual([{ id: 'formato', unsure: true }, { id: 'nota', text: 'x' }]);
  });
});
