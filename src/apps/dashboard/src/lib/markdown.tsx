import type { MouseEvent } from 'react';
import { type ShellActions, useMarkdown, useShell } from '../shell/hooks.js';

// Markdown from GitHub, cleaned (lib/md.ts), in a `<div class="md">`. A
// #123 the sidebar has opens its page here.

function openRef(shell: ShellActions, hasItem: (key: string) => boolean, e: MouseEvent) {
  const ref = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-ref]')?.dataset.ref;
  if (ref && hasItem(ref)) {
    e.preventDefault();
    shell.openItem(ref);
  }
}

export function Md({ text, repo, className = 'md' }: { text: string; repo: string; className?: string }) {
  const shell = useShell();
  const markdown = useMarkdown();
  return <div className={className} onClick={(e) => openRef(shell, markdown.hasItem, e)} dangerouslySetInnerHTML={{ __html: markdown.html(text, repo) }} />;
}
