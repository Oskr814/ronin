import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

const readFile = vi.fn();
vi.mock('node:fs/promises', () => ({ readFile }));

const { loadReviewCriteria, REVIEW_CRITERIA_PATH } = await import('./review-criteria.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadReviewCriteria', () => {
  it('reads the criteria from ronin\'s own checkout, never from the product repo', async () => {
    readFile.mockResolvedValue(Buffer.from('# Criterio\n'));

    const { text } = await loadReviewCriteria();

    expect(readFile).toHaveBeenCalledWith(join(process.cwd(), REVIEW_CRITERIA_PATH));
    expect(text).toBe('# Criterio\n');
  });

  it('hashes the content exactly like `git hash-object`', async () => {
    readFile.mockResolvedValue(Buffer.from('hello\n'));

    const { blobHash } = await loadReviewCriteria();

    // `echo hello | git hash-object --stdin`
    expect(blobHash).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('uses the byte length, not the character length, for non-ASCII content', async () => {
    readFile.mockResolvedValue(Buffer.from('ñ\n'));

    const { blobHash } = await loadReviewCriteria();

    // `printf 'ñ\n' | git hash-object --stdin`
    expect(blobHash).toBe('35e695e8342dd9a68c7776bbf7cab6592f02b256');
  });

  it('fails when the file is missing — reviewing without criteria is not a fallback', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(loadReviewCriteria()).rejects.toThrow('ENOENT');
  });
});
