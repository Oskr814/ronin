import type { MouseEvent } from 'react';
import { useHost, type Host } from '../host.js';

// Markdown from GitHub, cleaned by the shell (Host.markdown), in a
// `<div class="md">`. A #123 the sidebar has opens its page here.

export function openRef(host: Host, e: MouseEvent) {
  const ref = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-ref]')?.dataset.ref;
  if (ref && host.hasItem(ref)) {
    e.preventDefault();
    host.openItem(ref);
  }
}

export function Md({ text, repo, className = 'md' }: { text: string; repo: string; className?: string }) {
  const host = useHost();
  return <div className={className} onClick={(e) => openRef(host, e)} dangerouslySetInnerHTML={{ __html: host.markdown(text, repo) }} />;
}
