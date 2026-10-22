// Where ronin's own footer starts in the body of a PR it opened: the
// commands table (domains/commands/help.ts). What goes before it is the PR's
// description, which ronin rewrites and links to Linear above the footer.
export const HELP_FOOTER_MARKER = '<!-- ronin:help -->';

// The issues a PR body would close on merge, by GitHub's closing keywords
// ("Closes #9", "fixes: #9", "Resolved owner/repo#9"), in this repo or
// another. A slice PR of an issue with several slices must have none: merged,
// it would close the issue with slices still to do, and ronin would take it
// for done (#515 of bmedical, after slice 1 of 12).
export function closingRefs(body: string): string[] {
  const refs = body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+((?:[\w.-]+\/[\w.-]+)?#\d+)\b/gi);
  return [...new Set([...refs].map((m) => m[1]!.toLowerCase()))];
}

// The section of a ronin PR's description where its internal review (#194)
// leaves what only a person can decide. While it has a question, auto-merge
// waits (domains/commands/auto-merge.ts).
export const QUESTIONS_SECTION = 'Preguntas';

// What the «Preguntas» section of a PR body says, up to the next section or
// the footer, without its hidden options; empty when there is none.
export function openQuestions(body: string): string {
  return questionsSection(body).replace(/<!--[\s\S]*?-->/g, '').trim();
}

function questionsSection(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##[ \\t]+${QUESTIONS_SECTION}[ \\t]*$`).test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##[ \t]/.test(l) || l.startsWith(HELP_FOOTER_MARKER));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// Each question's suggested answers go right under it, hidden from GitHub's
// view of the description: `<!-- ronin:opciones ["…", "…"] -->`. The
// dashboard shows them as buttons; removing a question removes them with it.
export const OPTIONS_MARKER = 'ronin:opciones';

export interface PrQuestion {
  // What the person reads: the question and why it matters, as markdown.
  text: string;
  options: string[];
}

// The open questions one by one, with their options (none when they have
// no hidden block, or it can't be read).
export function prQuestions(body: string): PrQuestion[] {
  return questionsSection(body).split(/^(?=\d+\.[ \t])/m).flatMap((item) => {
    if (!/^\d+\.[ \t]/.test(item)) return [];
    let options: string[] = [];
    const hidden = new RegExp(`<!--[ \\t]*${OPTIONS_MARKER}([\\s\\S]*?)-->`).exec(item);
    if (hidden) {
      try {
        const parsed: unknown = JSON.parse(hidden[1]);
        if (Array.isArray(parsed)) options = parsed.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim());
      } catch {
        // A block that doesn't read leaves the question without options.
      }
    }
    const text = item.replace(/<!--[\s\S]*?-->/g, '').replace(/^\d+\.[ \t]+/, '').replace(/\n[ \t]+/g, '\n').trim();
    return text ? [{ text, options }] : [];
  });
}
