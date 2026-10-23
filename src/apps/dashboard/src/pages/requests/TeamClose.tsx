import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { firstName, type Detail } from './model.js';

// Cerrar pedido (#404): while the request has no issue and waits on the
// person, ronin answered it, or ronin reads it, someone with the repo's
// actions closes it with a reason the person gets in those words, in the
// portal and by mail. With an issue, it closes from the issue.

const CLOSABLE = ['thinking', 'asking', 'answered', 'interviewing', 'confirming', 'proposed'];

export function TeamClose({ d }: { d: Detail }) {
  const shell = useShell();
  const session = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!CLOSABLE.includes(d.status) || d.issue || !session.can(d.repo, 'acciones')) return null;
  const who = firstName(d.person);

  const send = async () => {
    if (sending || !reason.trim()) return;
    setSending(true);
    setError(null);
    try {
      const closed = await ok(client.api.requests[':n'].close.$post({ param: { n: String(d.number) }, json: { reason: reason.trim() } }));
      queryClient.setQueryData(['request', d.number], closed);
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
      shell.toast(`Cerraste P-${d.number}: ${who} recibe el motivo.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      setError(`No se pudo: ${(e as Error).message}`);
      setSending(false);
    }
  };

  if (!open) return <div className="pd-close"><button className="btn-s danger" onClick={() => { setOpen(true); setReason(''); setError(null); }}>Cerrar pedido</button></div>;
  return (
    <div className="pd-close pd-dd">
      <label className="field"><span>Por qué se cierra. Le llega a {who} con estas palabras, en el portal y por correo.{d.status === 'thinking' ? ' Si ronin lo está leyendo, termina y no le cambia nada.' : ''}</span>
        <textarea rows={3} maxLength={2000} autoFocus value={reason} placeholder="Por ejemplo: eso ya se puede hacer desde Reportes → Ventas." onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
          }} /></label>
      <div className="acts"><button className="btn-s" disabled={sending} onClick={() => setOpen(false)}>Volver</button><button className="btn-s danger-solid" disabled={sending || !reason.trim()} onClick={() => void send()}>{sending ? 'Cerrando…' : 'Cerrar pedido'}</button></div>
      {error && <p className="bad">{error}</p>}
    </div>
  );
}
