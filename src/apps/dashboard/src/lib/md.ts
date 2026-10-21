import { marked } from '../../vendor/marked.esm.js';
import DOMPurify from '../../vendor/purify.esm.js';

// Markdown from GitHub. Whatever comes from there (a PR from anyone, a
// comment) is untrusted: it's parsed by marked and then cleaned by DOMPurify
// before it reaches the page. Images become links (the CSP wouldn't load
// them anyway), except the screenshots ronin publishes, which the server
// reads from its own clone (/api/evidence); links open outside, and a #123
// carries the item it is (data-ref), which opens here when the sidebar has
// it (lib/markdown.tsx).

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'INPUT') node.setAttribute('disabled', '');
});
const cache = new Map<string, string>();

const safeRepo = (repo: string) => /^[\w.-]+\/[\w.-]+$/.test(repo);

// A screenshot ronin published (evidenceUrl in runs/evidence-store.ts) of
// a repo on the dashboard, as the server serves it from its clone.
export function evidenceSrc(repos: string[], src: string | null | undefined): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/([0-9a-f]{7,40})\/([^?#]+)\?raw=true$/.exec(src ?? '');
  if (!m || !repos.includes(m[1])) return null;
  return `/api/evidence/${m[1]}/${m[2]}/${m[3]}`;
}

// `repos`: the dashboard's, whose screenshots it shows.
export function md(text: string | null | undefined, repo: string, repos: string[]): string {
  const key = `${repo}\n${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const clean = DOMPurify.sanitize(marked.parse(text ?? '', { gfm: true, breaks: true }), { FORBID_TAGS: ['style', 'form', 'button', 'select', 'textarea', 'iframe', 'video', 'audio'], ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  for (const img of tpl.content.querySelectorAll('img')) {
    const link = document.createElement('a');
    link.href = img.getAttribute('src') ?? '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const label = `[imagen${img.alt ? `: ${img.alt}` : ''}]`;
    const local = evidenceSrc(repos, img.getAttribute('src'));
    if (local) {
      // The link still opens it on GitHub; if it doesn't load here, the label
      // takes its place (the shell's 'error' listener).
      img.src = local;
      img.className = 'ev';
      img.loading = 'lazy';
      img.dataset.label = label;
      img.replaceWith(link);
      link.append(img);
    } else {
      link.textContent = label;
      img.replaceWith(link);
    }
  }
  if (safeRepo(repo)) linkRefs(tpl.content, repo);
  const html = tpl.innerHTML;
  if (cache.size > 200) cache.clear();
  cache.set(key, html);
  return html;
}

// Each #123 in the text, a link to it on GitHub that knows which item it is.
function linkRefs(root: DocumentFragment, repo: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes: Text[] = [];
  while (walker.nextNode()) if (/(^|[^\w&/])#\d+\b/.test(walker.currentNode.nodeValue ?? '')) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue ?? '';
    for (const m of text.matchAll(/(^|[^\w&/])#(\d+)\b/g)) {
      const at = m.index + m[1].length;
      frag.append(text.slice(last, at));
      const link = document.createElement('a');
      link.href = `https://github.com/${repo}/issues/${m[2]}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.dataset.ref = `${repo}#${m[2]}`;
      link.textContent = `#${m[2]}`;
      frag.append(link);
      last = at + m[2].length + 1;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}
