import { describe, it, expect } from 'vitest';
import { docsSubject, styleOf } from './commit-style.js';

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

describe('docsSubject', () => {
  it('prefixes per style', () => {
    expect(docsSubject('conventional', 'exploration', 'exploración', 'feedback del PR #351')).toBe('docs(exploration): feedback del PR #351');
    expect(docsSubject('plain', 'exploration', 'exploración', 'feedback del PR #351')).toBe('exploración: feedback del PR #351');
  });
});
