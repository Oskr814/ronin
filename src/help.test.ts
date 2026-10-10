import { describe, it, expect } from 'vitest';
import {
  classifyMetaCommand,
  suggestCommand,
  levenshtein,
  renderMetaReply,
  renderCommandTable,
  withHelpFooter,
  HELP_FOOTER_MARKER,
} from './help.js';

describe('classifyMetaCommand', () => {
  it('recognizes /help in both contexts', () => {
    expect(classifyMetaCommand('@ronin /help', 'ronin', 'pr')).toEqual({ kind: 'help' });
    expect(classifyMetaCommand('@ronin /help', 'ronin', 'issue')).toEqual({ kind: 'help' });
  });

  it('is case-insensitive for both the handle and the command', () => {
    expect(classifyMetaCommand('@Ronin /HELP', 'ronin', 'pr')).toEqual({ kind: 'help' });
  });

  it('lets a command through where it applies', () => {
    expect(classifyMetaCommand('@ronin /fix-comments', 'ronin', 'pr')).toBeNull();
    expect(classifyMetaCommand('@ronin /spike backoffice revisá el checkout', 'ronin', 'issue')).toBeNull();
  });

  it('flags a command used in the wrong place', () => {
    expect(classifyMetaCommand('@ronin /spike backoffice', 'ronin', 'pr')).toEqual({ kind: 'wrong-context', command: 'spike' });
    expect(classifyMetaCommand('@ronin /fix-comments', 'ronin', 'issue')).toEqual({ kind: 'wrong-context', command: 'fix-comments' });
  });

  it('flags /spike with no app_name instead of letting it through silently', () => {
    expect(classifyMetaCommand('@ronin /spike', 'ronin', 'issue')).toEqual({ kind: 'bad-usage', command: 'spike' });
    expect(classifyMetaCommand('@ronin /spike   ', 'ronin', 'issue')).toEqual({ kind: 'bad-usage', command: 'spike' });
  });

  it('lets /spike through once it has an app_name, with or without an instruction', () => {
    expect(classifyMetaCommand('@ronin /spike backoffice', 'ronin', 'issue')).toBeNull();
    expect(classifyMetaCommand('@ronin /spike backoffice revisá el checkout', 'ronin', 'issue')).toBeNull();
  });

  it('flags an unknown command, with a suggestion when one is close', () => {
    expect(classifyMetaCommand('@ronin /fix-coments', 'ronin', 'pr')).toEqual({ kind: 'unknown', token: 'fix-coments', suggestion: 'fix-comments' });
    expect(classifyMetaCommand('@ronin /deploy', 'ronin', 'pr')).toEqual({ kind: 'unknown', token: 'deploy' });
  });

  it('only looks at the token right after the mention', () => {
    expect(classifyMetaCommand('@ronin revisá /src/foo.ts', 'ronin', 'pr')).toBeNull();
    expect(classifyMetaCommand('@ronin por favor', 'ronin', 'pr')).toBeNull();
    expect(classifyMetaCommand('sin mención /help', 'ronin', 'pr')).toBeNull();
  });
});

describe('suggestCommand', () => {
  it('matches a typo within edit distance 2', () => {
    expect(suggestCommand('fixcomments', 'pr')).toBe('fix-comments');
    expect(suggestCommand('spkie', 'issue')).toBe('spike');
    expect(suggestCommand('hlep', 'pr')).toBe('help');
  });

  it('matches a prefix of at least 3 characters', () => {
    expect(suggestCommand('fix', 'pr')).toBe('fix-comments');
    expect(suggestCommand('fi', 'pr')).toBeUndefined();
  });

  it('never suggests a command that does not apply in this context', () => {
    expect(suggestCommand('spik', 'pr')).toBeUndefined();
    expect(suggestCommand('fix-coments', 'issue')).toBeUndefined();
  });
});

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('fix-coments', 'fix-comments')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });
});

describe('renderMetaReply', () => {
  it('lists only the commands that apply in the current context', () => {
    const onPr = renderMetaReply({ kind: 'help' }, 'ronin', 'pr');
    expect(onPr).toContain('`@ronin /fix-comments`');
    expect(onPr).toContain('`@ronin <pedido>`');
    expect(onPr).not.toContain('/spike');

    const onIssue = renderMetaReply({ kind: 'help' }, 'ronin', 'issue');
    expect(onIssue).toContain('`@ronin /spike <app> [instrucción]`');
    expect(onIssue).not.toContain('/fix-comments');
  });

  it('includes the suggestion for a typo and links the wiki', () => {
    const reply = renderMetaReply({ kind: 'unknown', token: 'fix-coments', suggestion: 'fix-comments' }, 'ronin', 'pr');
    expect(reply).toContain('No conozco `/fix-coments`. ¿Quisiste decir `/fix-comments`?');
    expect(reply).toContain('https://github.com/Oskr814/ronin/wiki/Comandos');
  });

  it('shows the exact usage for a command missing a required argument', () => {
    const reply = renderMetaReply({ kind: 'bad-usage', command: 'spike' }, 'ronin', 'issue');
    expect(reply).toContain('Uso: `@ronin /spike <app> [instrucción]`.');
  });
});

describe('withHelpFooter', () => {
  it('appends the footer once and is idempotent', () => {
    const once = withHelpFooter('Descripción del slice', 'ronin');
    expect(once).toMatch(/^Descripción del slice\n\n<!-- ronin:help -->/);
    expect(once).toContain(renderCommandTable('ronin', 'pr'));
    expect(withHelpFooter(once, 'ronin')).toBe(once);
  });

  it('works on an empty body', () => {
    expect(withHelpFooter('', 'ronin').startsWith(HELP_FOOTER_MARKER)).toBe(true);
  });
});
