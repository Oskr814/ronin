import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, client, ok, type ItemCommand } from '@apps/dashboard/src/api.js';
import { type ItemView, reread, showDoc, useMarkdown, useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { itemParam, type Action } from './model.js';
import { clickTimer } from '@apps/dashboard/src/lib/click-timing.js';
import { addPending, dropPending, sentPending } from '@apps/dashboard/src/shell/pending.js';
import { commandsKey, loadRuns, queryClient } from '@apps/dashboard/src/shell/state.js';
import { commandName } from './Commands.js';

// The item's actions (#85): each one a command that exists on GitHub,
// commented as whoever is logged in (#93), the same comment they'd write
// there. The menu opens with M; in it a digit picks one, j/k or the arrows
// move, Enter asks for it.

export function ActionsMenu({ actions, open, setOpen, pick }: { actions: Action[]; open: boolean; setOpen: (open: boolean) => void; pick: (action: Action) => void }) {
  return (
    <div className="actions"><button className="act-btn" id="act" aria-haspopup="menu" aria-expanded={open} title="Acciones (M)" onClick={(e) => {
      e.stopPropagation();
      setOpen(!open);
    }}>Acciones <kbd>M</kbd> ▾</button>
    {open && <div className="menu" role="menu">{actions.map((a, i) => (
      <button key={a.id} role="menuitem" data-action={a.id} className={a.primary ? 'primary' : ''} onClick={(e) => {
        e.stopPropagation();
        pick(a);
      }}><b>{i < 9 && <><kbd>{i + 1}</kbd> </>}{a.label}</b><span className="k">{a.command}</span><small>{a.help}</small></button>
    ))}</div>}</div>
  );
}

// The menu's keys while it's open. True when the key was its.
export function menuKey(event: KeyboardEvent, pick: (id: string) => void, toggle: () => void): boolean {
  const all = [...document.querySelectorAll<HTMLButtonElement>('.menu [data-action]')];
  if (!all.length) return false;
  if (/^[1-9]$/.test(event.key) && all[Number(event.key) - 1]) {
    event.preventDefault();
    pick(all[Number(event.key) - 1].dataset.action!);
    return true;
  }
  const step = ({ j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
  if (step) {
    event.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[at < 0 ? (step > 0 ? 0 : all.length - 1) : (at + step + all.length) % all.length].focus();
    return true;
  }
  if (event.key.toLowerCase() === 'm') {
    event.preventDefault();
    toggle();
    return true;
  }
  return false;
}

// How long an action waits for the server's answer. The comment is usually
// out within a few seconds; past this, the answer was lost on the way (a
// phone whose connection to the tailnet dropped), and waiting longer would
// leave the dialog on "Comentando…" for good.
const ACTION_TIMEOUT_MS = 30_000;

export interface Asked {
  item: string;
  action: Action;
  // Asked again after it failed: what was written, and why it didn't go.
  retry?: { text: string; app: string; error: string };
}

// `busy`: what the page's Escape waits on; this dialog closes as it sends, so it never holds it.
// `reopen`: back with what was written and the error, if the page is still
// on the item.
export function ActionDialog({ v, asked, close, reopen, busy }: { v: ItemView; asked: Asked; close: () => void; reopen: (asked: Asked) => void; busy: MutableRefObject<boolean> }) {
  const shell = useShell();
  const session = useSession();
  const markdown = useMarkdown();
  const { action } = asked;
  const [text, setText] = useState(asked.retry?.text ?? '');
  const [app, setApp] = useState(asked.retry?.app ?? action.app ?? action.apps?.[0] ?? '');
  const [error, setError] = useState<string | null>(asked.retry?.error ?? null);
  const first = useRef<HTMLTextAreaElement & HTMLButtonElement>(null);
  // Sent once: the dialog closes as it goes, so the page's Escape is never held up by it.
  const sent = useRef(false);
  busy.current = false;
  useEffect(() => first.current?.focus(), []);

  // `…` stands for the text: filled as it's typed, left out when the text is optional and empty.
  // `{app}`, for the app picked. On one line, as the server writes it.
  const typed = action.apps && action.id !== 'preview' ? text.trim().replace(/\s+/g, ' ') : text.trim();
  const preview = (!action.text ? action.preview : typed ? action.preview.replace('…', typed) : action.text.required ? action.preview : action.preview.replace(/(\n\n| )?…$/, '')).replace('{app}', app);
  const me = session.me;
  const bot = v.detail?.data?.ronin ?? 'ronin';
  // Assigning and closing comment only when there's something to say.
  const said = action.id === 'assign' ? (typed ? `Comentás en #${action.target} y se lo asignás a @${bot}, como ${me}` : `Se lo asignás a @${bot} como ${me}, sin comentario`)
    : action.id === 'close-issue' ? (typed ? `Comentás en #${action.target} y lo cerrás como no planeado, como ${me}` : `Lo cerrás como no planeado, como ${me}, sin comentario`)
    : action.direct ? `Se lo pedís a ronin como ${me}: no se escribe nada en GitHub, la respuesta queda en el ítem`
    : `Comentás en #${action.target} como ${me}`;
  const disabled = Boolean(action.text?.required && !text.trim());

  // Optimistic (#368): the dialog closes at once, and what it writes is in
  // the conversation of what it's on, as being sent — the comment as
  // previewed, or what's done when there's none. If it doesn't go, it
  // leaves the conversation and the dialog comes back with the text and why.
  const send = async () => {
    if (sent.current || disabled) return;
    sent.current = true;
    const body = { action: action.id, ...(text.trim() ? { text: text.trim() } : {}), ...(action.apps ? { app } : {}) };
    if (action.direct) return askRonin(body);
    const shown = clickTimer('accion');
    const comments = !['assign', 'close-issue'].includes(action.id) || Boolean(typed);
    const pending = addPending({
      repo: v.item.repo,
      number: action.target,
      author: me,
      body: comments ? preview : '',
      ...(comments ? {} : { note: action.id === 'assign' ? `Se lo asignás a @${bot}.` : 'Lo cerrás como no planeado.' }),
    });
    close();
    // Its comment is where the answer will come: the tab of what it was on (the issue or its PR).
    const d = v.detail?.data;
    if (d) showDoc(asked.item, d.pr?.number === action.target ? 'pr' : 'issue');
    try {
      // A refusal makes the client's type of the answer {} (Explorar ahora's too): it's written here.
      const { url } = (await ok(client.api.items[':id'].actions.$post({ param: itemParam(asked.item), json: body }, { init: { signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) } }))) as { url?: string };
      shell.toast(action.id === 'assign' ? `Listo: se lo asignaste a ronin. Lo toma en el próximo tick.` : action.id === 'close-issue' ? `Listo: cerraste #${action.target}.` : `Listo: comentaste en #${action.target}.`, url);
      if (comments) {
        sentPending(pending, url);
        shown(reread(asked.item));
      } else {
        // Nothing in the conversation to wait for: the note goes once the item is read again.
        const read = reread(asked.item);
        shown(read);
        void read.then(() => dropPending(pending));
      }
    } catch (e) {
      dropPending(pending);
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      // No answer, or the connection dropped: the comment may well be out
      // already. The item is read again so its conversation says.
      const err = e as Error;
      const lost = err.name === 'TimeoutError' || err.name === 'AbortError' || err instanceof TypeError;
      const error = lost
        ? 'No llegó la respuesta del servidor. El comentario puede haberse publicado igual: mira la conversación del ítem antes de volver a intentar.'
        : `No se pudo: ${err.message}`;
      if (lost) void reread(asked.item);
      shell.toast(`No se pudo ${action.id === 'assign' ? 'asignar' : action.id === 'close-issue' ? 'cerrar' : 'comentar'} en #${action.target}: ${lost ? 'no llegó la respuesta del servidor' : err.message}`);
      reopen({ ...asked, retry: { text, app, error } });
    }
  };
  // Straight to ronin (#446): under the item's activity at once, as asked
  // by the person; the command the server kept takes its place.
  const askRonin = async (body: { action: string; text?: string; app?: string }) => {
    const shown = clickTimer('pedir');
    const key = commandsKey(asked.item);
    const pending: ItemCommand = { id: `pending-${Date.now()}`, repo: v.item.repo, number: action.target, kind: action.id, args: { ...(body.app ? { app: body.app } : {}), ...(body.text ? { text: body.text } : {}) }, requestedBy: me, status: 'queued', messages: [], runId: null, error: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null };
    const without = (list: ItemCommand[] | undefined) => (list ?? []).filter((c) => c.id !== pending.id);
    queryClient.setQueryData<ItemCommand[]>(key, (list) => [pending, ...(list ?? [])]);
    close();
    try {
      const done = (await ok(client.api.items[':id'].actions.$post({ param: itemParam(asked.item), json: body }, { init: { signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) } }))) as { command?: ItemCommand; existing?: boolean };
      const command = done.command;
      queryClient.setQueryData<ItemCommand[]>(key, (list) => (command ? [command, ...without(list).filter((c) => c.id !== command.id)] : without(list)));
      shell.toast(command && done.existing
        ? `${command.requestedBy === me ? 'Ya lo habías pedido' : `Ya lo pidió ${command.requestedBy}`}: ronin está en eso.`
        : `Listo: le pediste a ronin ${command ? commandName(command).replace(/^./, (x) => x.toLowerCase()) : 'eso'}. La respuesta queda acá.`);
      shown(loadRuns(asked.item));
    } catch (e) {
      queryClient.setQueryData<ItemCommand[]>(key, without);
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      const err = e as Error;
      const lost = err.name === 'TimeoutError' || err.name === 'AbortError' || err instanceof TypeError;
      if (lost) void loadRuns(asked.item);
      const error = lost ? 'No llegó la respuesta del servidor. Puede haberse pedido igual: mira los pedidos del ítem antes de volver a intentar.' : `No se pudo: ${err.message}`;
      shell.toast(`No se pudo pedir: ${lost ? 'no llegó la respuesta del servidor' : err.message}`);
      reopen({ ...asked, retry: { text, app, error } });
    }
  };
  const cancel = () => {
    close();
  };

  return createPortal(
    <div id="layer"><div className="scrim" onClick={(e) => {
      if ((e.target as HTMLElement).classList.contains('scrim')) cancel();
    }}><div className="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t" onKeyDown={(e) => {
      // Anywhere in the dialog, as long as the button could be pressed.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !disabled) {
        e.preventDefault();
        void send();
      }
    }}>
      <h2 id="dlg-t">{action.label}</h2>
      <p className="help">{action.help}</p>
      {action.apps && <label className="field"><span>App</span><select id="dlg-app" value={app} onChange={(e) => setApp(e.target.value)}>{action.apps.map((a) => <option key={a} value={a}>{a}{a === action.app && action.appNote ? ` · ${action.appNote}` : ''}</option>)}</select></label>}
      {action.text && <label className="field"><span>{action.text.label}</span><textarea id="dlg-text" ref={first} rows={4} maxLength={4000} placeholder={action.text.placeholder} value={text} onChange={(e) => setText(e.target.value)} /></label>}
      <div className="prev"><div className="lbl" id="dlg-said">{said}</div><div className="md" id="dlg-prev" hidden={!preview || action.direct} dangerouslySetInnerHTML={{ __html: markdown.html(preview, v.item.repo) }} /></div>
      <p className="bad" id="dlg-err" hidden={!error}>{error ?? ''}</p>
      <div className="foot-d"><span className="kbd-hint"><kbd>Ctrl</kbd> <kbd>Enter</kbd> para {action.id === 'assign' ? 'asignar' : action.id === 'close-issue' ? 'cerrar' : action.direct ? 'pedir' : 'comentar'}</span><button className="btn-s" id="dlg-no" onClick={cancel}>Cancelar</button>
        <button className={`btn-s ${action.id === 'close-issue' ? 'danger-solid' : 'primary'}`} id="dlg-yes" ref={action.text ? undefined : first} disabled={disabled} onClick={() => void send()}>{action.id === 'assign' ? 'Asignar a ronin' : action.id === 'close-issue' ? 'Cerrar el issue' : action.id === 'unblock' ? (action.direct ? 'Destrabar' : 'Comentar y destrabar') : action.direct ? 'Pedir' : 'Comentar'}</button></div></div></div></div>,
    document.body,
  );
}
