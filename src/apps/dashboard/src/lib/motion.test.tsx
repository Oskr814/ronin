// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLASH_MS, landOn, useFlash } from './motion.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useFlash (#372)', () => {
  it('lights up for a moment when the value moves into one it watches, not when first seen', () => {
    const seen = new Map<string, string>();
    const when = (status: string) => status === 'blocked' || status === 'running';
    const { result, rerender } = renderHook(({ status }) => useFlash('acme/web#1', status, seen, when), { initialProps: { status: 'open' } });
    expect(result.current).toBe(false);
    rerender({ status: 'blocked' });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(FLASH_MS));
    expect(result.current).toBe(false);
    rerender({ status: 'open' });
    expect(result.current).toBe(false);
  });

  it("doesn't light up a row that comes back to the list with the status it had", () => {
    const seen = new Map([['acme/web#1', 'running']]);
    const { result } = renderHook(() => useFlash('acme/web#1', 'running', seen));
    expect(result.current).toBe(false);
  });
});

describe('landOn', () => {
  it('outlines where a jump landed, for a moment', () => {
    const el = document.createElement('div');
    landOn(el);
    expect(el.classList.contains('landed')).toBe(true);
    vi.advanceTimersByTime(FLASH_MS);
    expect(el.classList.contains('landed')).toBe(false);
  });
});
