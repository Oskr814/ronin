import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { firstName, impactLine, type Detail } from './model.js';

// A prioritario (#430): why the person said it can't wait, atop its
// activity while it is one. Someone with the repo's actions can take it
// away with a reason the person gets: it goes on as a normal request.

export function Priority({ d }: { d: Detail }) {
  const shell = useShell();
  const session = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = d.priorityNote;
  if (!p || !d.priority) return null;
  const who = firstName(d.person);
  const can = session.can(d.repo, 'acciones');

  const send = async () => {
    if (sending || !reason.trim()) return;
    setSending(true);
    setError(null);
    try {
      const next = await ok(client.api.requests[':n'].priority.remove.$post({ param: { n: String(d.number) }, json: { reason: reason.trim() } }));
      queryClient.setQueryData(['request', d.number], next);
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
      shell.toast(`P-${d.number} ya no es prioritario: ${who} recibe el motivo.`);
    } catch (e) {
      setSending(false);
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      setError(`No se pudo: ${(e as Error).message}`);
    }
  };

  return (
    <div className="pd-now pd-prio-card">
      <div className="k">Prioritario</div>
      <div className="t">{impactLine(p)}</div>
      <div className="d">{p.reason}</div>
      <div className="m">{who} lo marcó al aprobarlo. Va primero en Pedidos mientras siga abierto.</div>
      {can && !open && <div className="acts"><button className="btn-s" onClick={() => { setOpen(true); setReason(''); setError(null); }}>Quitar la prioridad</button></div>}
      {can && open && (
        <div className="pd-dd">
          <p>El pedido sigue igual, como uno normal. A {who} le llega tu motivo en el portal y por correo.</p>
          <label className="field"><span>Por qué no es prioritario. Le llega a {who} con estas palabras.</span>
            <textarea rows={2} maxLength={500} autoFocus value={reason} placeholder="Por ejemplo: hoy se puede seguir haciendo a mano, así que no detiene el trabajo." onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
              }} /></label>
          <div className="acts"><button className="btn-s" disabled={sending} onClick={() => setOpen(false)}>Volver</button><button className="btn-s primary" disabled={sending || !reason.trim()} onClick={() => void send()}>{sending ? 'Quitando…' : 'Quitar la prioridad'}</button></div>
          {error && <p className="bad">{error}</p>}
        </div>
      )}
    </div>
  );
}
