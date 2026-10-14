import { describe, it, expect } from 'vitest';
import { applyScopeChange, appendInvestigation, readSection, upsertSection } from './issue-sections.js';

const ORIGINAL = 'Al abrir un grupo y volver se pierde la búsqueda.\n\nPara que lo implemente, asignámelo. `ronin-ficha:backoffice/F-0009`';

describe('upsertSection', () => {
  it('appends a section that is not there, and replaces it in place once it is', () => {
    const once = upsertSection(ORIGINAL, 'alcance', 'uno');
    expect(once.startsWith(ORIGINAL)).toBe(true);
    expect(readSection(once, 'alcance')).toBe('uno');

    const edited = `${once}\n\nTexto que alguien agregó después.`;
    const twice = upsertSection(edited, 'alcance', 'dos');
    expect(readSection(twice, 'alcance')).toBe('dos');
    expect(twice).toContain('Texto que alguien agregó después.');
    expect(twice.indexOf('dos')).toBeLessThan(twice.indexOf('Texto que alguien'));
  });

  it('treats a start marker with no end as absent instead of eating the rest of the body', () => {
    const broken = `${ORIGINAL}\n\n<!-- ronin:alcance -->\nresto`;
    expect(readSection(broken, 'alcance')).toBeUndefined();
    expect(upsertSection(broken, 'alcance', 'nuevo')).toContain('resto');
  });
});

describe('applyScopeChange', () => {
  const change = (n: number) => ({ alcance: `Alcance ${n}`, cambio: `cambio ${n}`, commentUrl: `https://x/c${n}`, date: `2026-10-1${n}` });

  it('keeps the original description untouched and puts the scope before its history', () => {
    const body = applyScopeChange(ORIGINAL, change(3));
    expect(body.startsWith(ORIGINAL)).toBe(true);
    expect(body).toContain('## Alcance');
    expect(body).toContain('Alcance 3');
    expect(body.indexOf('## Alcance')).toBeLessThan(body.indexOf('## Cambios de alcance'));
    expect(readSection(body, 'cambios-de-alcance')).toContain('- 2026-10-13: cambio 3 ([pedido](https://x/c3))');
  });

  it('replaces the scope and keeps adding to its history', () => {
    const body = applyScopeChange(applyScopeChange(ORIGINAL, change(3)), change(4));
    expect(body).not.toContain('Alcance 3');
    expect(body).toContain('Alcance 4');
    const history = readSection(body, 'cambios-de-alcance')!.split('\n').filter((l) => l.startsWith('- '));
    expect(history).toEqual(['- 2026-10-13: cambio 3 ([pedido](https://x/c3))', '- 2026-10-14: cambio 4 ([pedido](https://x/c4))']);
    expect(body.match(/## Alcance\n/g)).toHaveLength(1);
  });

  it('keeps a multi-line change description on its one history line', () => {
    const body = applyScopeChange(ORIGINAL, { ...change(3), cambio: 'primera línea\nsegunda' });
    expect(readSection(body, 'cambios-de-alcance')).toContain('- 2026-10-13: primera línea segunda (');
  });
});

describe('appendInvestigation', () => {
  it('adds each investigation at the end, never replacing an earlier one', () => {
    const once = appendInvestigation(ORIGINAL, { contexto: 'hallazgo A', commentUrl: 'https://x/1', date: '2026-10-13' });
    const twice = appendInvestigation(once, { contexto: 'hallazgo B', commentUrl: 'https://x/2', date: '2026-10-14' });
    expect(twice.startsWith(ORIGINAL)).toBe(true);
    expect(twice).toContain('## Contexto adicional (2026-10-13)');
    expect(twice).toContain('hallazgo A');
    expect(twice.indexOf('hallazgo A')).toBeLessThan(twice.indexOf('hallazgo B'));
  });
});
