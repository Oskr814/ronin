import { describe, expect, it } from 'vitest';
import { HELP_FOOTER_MARKER } from '../../domains/commands/help.js';
import { linearIdInPr, linearRefFrom, withLinearLink } from './linear.js';

const LINKBACK = '<!-- linear-linkback -->\n<p><a href="https://linear.app/red-motos/issue/RED-214/extraer-un-componente-de-pie">RED-214</a></p>';

describe('linearRefFrom', () => {
  it("reads the identifier and URL from the Linear bot's comment", () => {
    const comments = [{ author: 'oskr814', body: 'hola' }, { author: 'linear-code', body: LINKBACK }];
    expect(linearRefFrom(comments)).toEqual({ id: 'RED-214', url: 'https://linear.app/red-motos/issue/RED-214/extraer-un-componente-de-pie' });
  });

  it('accepts the REST login, with its [bot] suffix', () => {
    expect(linearRefFrom([{ author: 'linear-code[bot]', body: LINKBACK }])?.id).toBe('RED-214');
  });

  it('ignores the marker pasted by anyone else', () => {
    expect(linearRefFrom([{ author: 'oskr814', body: LINKBACK }])).toBeNull();
  });

  it('ignores a link outside linear.app', () => {
    expect(linearRefFrom([{ author: 'linear-code', body: '<!-- linear-linkback -->\n<a href="https://evil.example/issue/RED-1">RED-1</a>' }])).toBeNull();
  });

  it('is null without a linkback', () => {
    expect(linearRefFrom([])).toBeNull();
  });
});

describe('withLinearLink', () => {
  it('puts the line above the command footer', () => {
    expect(withLinearLink(`Resumen\n\n${HELP_FOOTER_MARKER}\n<details>`, 'RED-214', false)).toBe(`Resumen\n\n<!-- ronin:linear -->\nPart of RED-214\n\n${HELP_FOOTER_MARKER}\n<details>`);
  });

  it('appends it to a body without footer', () => {
    expect(withLinearLink('Resumen\n', 'RED-214', true)).toBe('Resumen\n\n<!-- ronin:linear -->\nFixes RED-214');
    expect(withLinearLink('', 'RED-214', true)).toBe('<!-- ronin:linear -->\nFixes RED-214');
  });

  it('rewrites the verb in place, and is idempotent', () => {
    const linked = withLinearLink('Resumen', 'RED-214', true);
    expect(withLinearLink(linked, 'RED-214', true)).toBe(linked);
    expect(withLinearLink(linked, 'RED-214', false)).toBe('Resumen\n\n<!-- ronin:linear -->\nPart of RED-214');
  });

  it("survives GitHub's CRLF", () => {
    const crlf = 'Resumen\r\n\r\n<!-- ronin:linear -->\r\nPart of RED-214\r\n\r\nmás';
    expect(linearIdInPr(crlf)).toBe('RED-214');
    expect(withLinearLink(crlf, 'RED-214', true)).toBe('Resumen\r\n\r\n<!-- ronin:linear -->\nFixes RED-214\r\n\r\nmás');
  });
});

describe('linearIdInPr', () => {
  it('reads the linked identifier, or null', () => {
    expect(linearIdInPr('x\n\n<!-- ronin:linear -->\nFixes RED-9')).toBe('RED-9');
    expect(linearIdInPr('Fixes RED-9')).toBeNull();
  });
});
