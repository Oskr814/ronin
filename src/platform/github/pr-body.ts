// Where ronin's own footer starts in the body of a PR it opened: the
// commands table (domains/commands/help.ts). What goes before it is the PR's
// description, which ronin rewrites and links to Linear above the footer.
export const HELP_FOOTER_MARKER = '<!-- ronin:help -->';

// The section of a ronin PR's description where its internal review (#194)
// leaves what only a person can decide. While it has a question, auto-merge
// waits (domains/commands/auto-merge.ts).
export const QUESTIONS_SECTION = 'Preguntas';

// What the «Preguntas» section of a PR body says, up to the next section or
// the footer; empty when there is none.
export function openQuestions(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##[ \\t]+${QUESTIONS_SECTION}[ \\t]*$`).test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##[ \t]/.test(l) || l.startsWith(HELP_FOOTER_MARKER));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
