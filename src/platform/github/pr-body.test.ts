import { describe, it, expect } from 'vitest';
import { HELP_FOOTER_MARKER, openQuestions, prQuestions } from './pr-body.js';

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

  it('leaves out the hidden options, so a section with only them has no questions', () => {
    expect(openQuestions('## Preguntas\n1. ¿Sí?\n   <!-- ronin:opciones ["Sí", "No"] -->\n')).toBe('1. ¿Sí?');
    expect(openQuestions('## Preguntas\n<!-- ronin:opciones ["Sí"] -->\n\n## Fuera de alcance')).toBe('');
  });
});

describe('prQuestions', () => {
  it('reads each question with the options hidden under it', () => {
    const body = [
      '## Preguntas',
      '',
      '1. ¿Se cobra el envío en pedidos de más de $50? Hoy no se cobra.',
      '   <!-- ronin:opciones ["Sí, se cobra siempre", "No, sigue gratis"] -->',
      '2. ¿Cuántos días dura la reserva?',
      '   Lo pide el issue pero no dice cuánto.',
      '',
      '## Fuera de alcance',
      '- Nada.',
    ].join('\n');
    expect(prQuestions(body)).toEqual([
      { text: '¿Se cobra el envío en pedidos de más de $50? Hoy no se cobra.', options: ['Sí, se cobra siempre', 'No, sigue gratis'] },
      { text: '¿Cuántos días dura la reserva?\nLo pide el issue pero no dice cuánto.', options: [] },
    ]);
  });

  it('has no options when the hidden block does not read, and no questions without the section', () => {
    expect(prQuestions('## Preguntas\n1. ¿Sí?\n   <!-- ronin:opciones [roto -->')).toEqual([{ text: '¿Sí?', options: [] }]);
    expect(prQuestions('## Qué cambió\n1. Algo.')).toEqual([]);
  });
});
