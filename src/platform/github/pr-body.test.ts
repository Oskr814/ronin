import { describe, it, expect } from 'vitest';
import { HELP_FOOTER_MARKER, openQuestions } from './pr-body.js';

describe('openQuestions', () => {
  it('reads the «Preguntas» section up to the next one', () => {
    const body = '## Decisiones propias\nNinguna.\n\n## Preguntas\n1. ¿Se cobra el envío?\n2. ¿Cuántos días?\n\n## Fuera de alcance\nNada.';
    expect(openQuestions(body)).toBe('1. ¿Se cobra el envío?\n2. ¿Cuántos días?');
  });

  it('stops at the help footer when it is the last section', () => {
    expect(openQuestions(`## Preguntas\n1. ¿Sí?\n\n${HELP_FOOTER_MARKER}\n| comando |`)).toBe('1. ¿Sí?');
  });

  it('is empty without the section, or with nothing in it', () => {
    expect(openQuestions('## Qué cambió\nAlgo.')).toBe('');
    expect(openQuestions('## Preguntas\n\n## Fuera de alcance\nNada.')).toBe('');
  });
});
