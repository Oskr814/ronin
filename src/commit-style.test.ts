import { describe, it, expect } from 'vitest';
import { acceptSubject, languageOf, styleOf } from './commit-style.js';

describe('styleOf', () => {
  it('reads a conventional-commits history, squash suffixes and scopes included', () => {
    expect(styleOf([
      'refactor(deploy): dedupe Dockerfiles (#345)',
      'fix(ci): optimizar CI (#344)',
      'feat(webapp): app shell density pass',
      'fix(webapp,backoffice): stop redirects',
      'test(webapp): improve logoIcon verification',
      'Exploración de ronin — semana 2026-W42 (#794)',
    ])).toBe('conventional');
  });

  it('is plain when most subjects are free text, ignoring merge commits', () => {
    expect(styleOf([
      'Add login page',
      'Fix typo in README',
      'Update deps',
      'Merge pull request #12 from x/y',
      'Merge branch main',
      'feat: one conventional',
      'Refactor checkout',
    ])).toBe('plain');
  });

  it('is plain with too little history to tell', () => {
    expect(styleOf(['feat: a', 'fix: b'])).toBe('plain');
  });
});

describe('languageOf', () => {
  it('reads Spanish and English histories past the type and scope', () => {
    expect(languageOf(['fix(backoffice): recargar la app cuando falla un chunk', 'feat(ui): ampliar Drawer con placements', 'fix(api): add hr_employee to the stub'])).toBe('es');
    expect(languageOf(['refactor(deploy): dedupe Dockerfiles and build jobs', 'fix(ci): optimizar CI y Deploy QA', 'feat(webapp): put the app shell on a fixed rail'])).toBe('en');
  });
});

describe('acceptSubject', () => {
  const prefix = 'docs(exploration): ';
  it('takes a single line with the prefix, stripping quotes', () => {
    expect(acceptSubject('"docs(exploration): add findings on owner self-deletion"\n', prefix)).toBe('docs(exploration): add findings on owner self-deletion');
  });
  it('rejects a wrong prefix, an empty description or an overlong line', () => {
    expect(acceptSubject('feat: add findings', prefix)).toBeUndefined();
    expect(acceptSubject('docs(exploration): x', prefix)).toBeUndefined();
    expect(acceptSubject(`docs(exploration): ${'a'.repeat(120)}`, prefix)).toBeUndefined();
  });
});
