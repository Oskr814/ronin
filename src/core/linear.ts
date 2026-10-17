import { HELP_FOOTER_MARKER } from '../commands/help.js';

// Linear, read from GitHub alone (#101, entrega 1): no API key. A repo whose
// issues sync with Linear gets, on each issue, a comment from Linear's bot
// with the issue's identifier:
//
//   <!-- linear-linkback -->
//   <p><a href="https://linear.app/red-motos/issue/RED-214/slug">RED-214</a></p>
//
// An issue without that comment (a repo that doesn't sync, or a sync that
// hasn't reached it yet) has no Linear issue, and nothing here applies.

export interface LinearRef {
  id: string;
  url: string;
}

const LINKBACK_MARKER = '<!-- linear-linkback -->';
// `gh issue view` gives a bot's login without the suffix, the REST API with it.
const LINEAR_BOT = /^linear(-code)?(\[bot\])?$/;
const LINKBACK_LINK = /<a href="(https:\/\/linear\.app\/[^"\s]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/[^"\s]*)?)"/;

// Only the bot's own comment counts: anyone can paste the marker.
export function linearRefFrom(comments: Array<{ author: string; body: string }>): LinearRef | null {
  for (const c of comments) {
    if (!LINEAR_BOT.test(c.author) || !c.body.includes(LINKBACK_MARKER)) continue;
    const m = LINKBACK_LINK.exec(c.body);
    if (m) return { id: m[2], url: m[1] };
  }
  return null;
}

export const LINEAR_PR_MARKER = '<!-- ronin:linear -->';
// \r: GitHub's editor saves a body with CRLF.
const LINEAR_PR_LINE = new RegExp(`${LINEAR_PR_MARKER}\\r?\\n[^\\r\\n]*`);
const LINEAR_PR_ID = new RegExp(`${LINEAR_PR_MARKER}\\r?\\n(?:Fixes|Part of) ([A-Z][A-Z0-9]*-\\d+)`);

// The identifier a PR body already links to, so a PR linked once needs no
// read of its issue's comments again.
export function linearIdInPr(body: string): string | null {
  return LINEAR_PR_ID.exec(body)?.[1] ?? null;
}

// The line that links a PR to its Linear issue: Linear shows the PR on the
// issue and, with the team's GitHub automations, moves it to In Progress when
// the first one opens and to Done when the one that `closes` merges. "Part of"
// links without closing (https://linear.app/docs/github). Kept above ronin's
// command footer, and rewritten if `closes` changed (a replan that added
// slices after this one). Idempotent: an unchanged body comes back as is.
export function withLinearLink(body: string, id: string, closes: boolean): string {
  const block = `${LINEAR_PR_MARKER}\n${closes ? 'Fixes' : 'Part of'} ${id}`;
  if (LINEAR_PR_LINE.test(body)) return body.replace(LINEAR_PR_LINE, block);
  const footer = body.indexOf(HELP_FOOTER_MARKER);
  if (footer === -1) return body.trim() ? `${body.trimEnd()}\n\n${block}` : block;
  const before = body.slice(0, footer).trimEnd();
  return `${before ? `${before}\n\n` : ''}${block}\n\n${body.slice(footer)}`;
}
