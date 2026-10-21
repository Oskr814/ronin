import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

const readFile = vi.fn();
const readdir = vi.fn();
vi.mock('node:fs/promises', () => ({ readFile, readdir }));

const { loadReviewCriteria, parseAgentFile, REVIEW_CRITERIA_PATH, REVIEW_AGENTS_DIR } = await import('./criteria.js');

function files(contents: Record<string, string>): void {
  readdir.mockResolvedValue(Object.keys(contents).filter((p) => p.startsWith(REVIEW_AGENTS_DIR)).map((p) => p.split('/').pop()));
  readFile.mockImplementation(async (path: string) => {
    const rel = path.slice(process.cwd().length + 1);
    if (!(rel in contents)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Buffer.from(contents[rel]);
  });
}

const AGENT = '---\ndescription: Seguridad\n---\n\n# Seguridad\n\n## Qué buscar\n- permisos\n';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadReviewCriteria', () => {
  it('reads the criteria and the agents from ronin\'s own checkout, never from the product repo', async () => {
    files({ [REVIEW_CRITERIA_PATH]: '# Criterio\n', [`${REVIEW_AGENTS_DIR}/review-security.md`]: AGENT });

    const { common, agents } = await loadReviewCriteria();

    expect(readFile).toHaveBeenCalledWith(join(process.cwd(), REVIEW_CRITERIA_PATH));
    expect(readdir).toHaveBeenCalledWith(join(process.cwd(), REVIEW_AGENTS_DIR));
    expect(common).toBe('# Criterio');
    expect(agents).toEqual([{ name: 'review-security', description: 'Seguridad', incrementalOnly: false, body: '# Seguridad\n\n## Qué buscar\n- permisos' }]);
  });

  it('gives the orchestrator the common criteria plus every dimension, nested under its own heading', async () => {
    files({ [REVIEW_CRITERIA_PATH]: '# Criterio\n', [`${REVIEW_AGENTS_DIR}/review-security.md`]: AGENT });

    const { text } = await loadReviewCriteria();

    expect(text).toBe('# Criterio\n\n## Detalle por dimensión\n\n### Agente `review-security`\n\n#### Seguridad\n\n##### Qué buscar\n- permisos');
  });

  it('hashes the criteria followed by the agents in name order, exactly like `cat … | git hash-object --stdin`', async () => {
    files({
      [REVIEW_CRITERIA_PATH]: 'hel',
      [`${REVIEW_AGENTS_DIR}/b.md`]: '---\ndescription: b\n---\nlo\n',
      [`${REVIEW_AGENTS_DIR}/a.md`]: '---\ndescription: a\n---\n',
    });

    const { blobHash, agents } = await loadReviewCriteria();

    expect(agents.map((a) => a.name)).toEqual(['a', 'b']);
    // printf 'hel---\ndescription: a\n---\n---\ndescription: b\n---\nlo\n' | git hash-object --stdin
    expect(blobHash).toBe('c7e8288630c3fbfa40b95431da4c1eb3b02e1960');
  });

  it('fails when the criteria file is missing — reviewing without criteria is not a fallback', async () => {
    files({ [`${REVIEW_AGENTS_DIR}/review-security.md`]: AGENT });

    await expect(loadReviewCriteria()).rejects.toThrow('ENOENT');
  });

  it('fails when there are no agents', async () => {
    files({ [REVIEW_CRITERIA_PATH]: '# Criterio\n' });

    await expect(loadReviewCriteria()).rejects.toThrow('no tiene agentes');
  });
});

describe('parseAgentFile', () => {
  it('reads the description and marks the delta worker as incremental-only', () => {
    expect(parseAgentFile('review-delta', '---\ndescription: Delta\nwhen: incremental\n---\n# Delta\n')).toEqual({
      name: 'review-delta',
      description: 'Delta',
      incrementalOnly: true,
      body: '# Delta',
    });
  });

  it('fails on an agent without a description', () => {
    expect(() => parseAgentFile('x', '# Sin frontmatter\n')).toThrow('falta "description"');
  });
});
