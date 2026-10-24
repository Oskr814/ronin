import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ItemCommand } from '@apps/dashboard/src/api.js';
import { type ItemView, useMarkdown } from '@apps/dashboard/src/shell/hooks.js';
import { commandsKey, itemCommands } from '@apps/dashboard/src/shell/state.js';
import { RunDot } from '@apps/dashboard/src/lib/runs.js';
import { short } from '@ui/time.js';

// What was asked of ronin on the item from the tablero (#446), under its
// activity: who asked for what, how it's going and what ronin answered —
// what used to be a comment and its reply on GitHub. The ones going on,
// and the last few that ended in the last day; each opens what ronin said.

const SHOWN = 3;
const RECENT_MS = 24 * 60 * 60 * 1000;

const NAME: Record<string, (c: ItemCommand) => string> = {
  preview: (c) => `Preview${typeof c.args.app === 'string' ? ` de ${c.args.app}` : ''} en #${c.number}`,
  'preview-stop': (c) => `Bajar la preview de #${c.number}`,
  'preview-update': (c) => `La preview de #${c.number} al último commit`,
};
const STATE: Record<string, [string, string]> = {
  queued: ['open', 'en cola'],
  running: ['running', 'trabajando'],
  done: ['ok', 'listo'],
  failed: ['error', 'no se pudo'],
};
export const commandName = (c: ItemCommand) => (NAME[c.kind] ?? ((x: ItemCommand) => x.kind))(c);

export function Commands({ v }: { v: ItemView }) {
  const id = v.item.id;
  // Kept with the item's runs (shell/state.ts readRuns); here only to follow them.
  const { data } = useQuery({ queryKey: commandsKey(id), queryFn: async () => itemCommands(id), enabled: false });
  const commands = (data ?? []).filter((c, i) => c.status === 'queued' || c.status === 'running' || (i < SHOWN && Date.now() - Date.parse(c.finishedAt ?? c.createdAt) < RECENT_MS)).slice(0, SHOWN);
  if (!commands.length) return null;
  return <div className="cmds" aria-label="Pedidos a ronin">{commands.map((c, i) => <Row key={c.id} c={c} first={i === 0} repo={v.item.repo} />)}</div>;
}

function Row({ c, first, repo }: { c: ItemCommand; first: boolean; repo: string }) {
  const markdown = useMarkdown();
  const going = c.status === 'queued' || c.status === 'running';
  const [open, setOpen] = useState(false);
  const [state, label] = STATE[c.status] ?? STATE.failed;
  const last = c.messages[c.messages.length - 1];
  // The last answer of the one going on, or of the latest; all of them, opened.
  const said = open ? c.messages : (going || first) && last ? [last] : [];
  const by = c.requestedBy === 'ronin' || c.kind === 'preview-update' ? 'ronin, por un push' : c.requestedBy;
  return (
    <div className={`cmd ${c.status}`} data-command={c.id}>
      <button className="cmd-top" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!c.messages.length}>
        <RunDot state={state} /><b>{commandName(c)}</b><span className="m">{label} · pedido por {by} · hace {short(Date.now() - Date.parse(c.createdAt))}</span>
        {c.messages.length > 1 && <span className="n">{open ? 'menos' : `${c.messages.length} respuestas`}</span>}
      </button>
      {said.map((m, i) => <div key={i} className="cmd-say md" dangerouslySetInnerHTML={{ __html: markdown.html(m.text, repo) }} />)}
      {!c.messages.length && going && <div className="cmd-say m">{c.status === 'queued' ? 'Esperando a que el runner lo tome…' : 'Arrancando…'}</div>}
    </div>
  );
}
