import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { explored, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { hhmm, repoShort } from '@apps/dashboard/src/lib/format.js';
import { at, rowOf, useExplorations } from './model.js';

// Explorar ahora (#155, 3/4). ronin still chooses the functions and the
// charters: the dialog only asks how many, for how long, and whether it
// stands for tonight's run. The shell opens it on its own (the app's page and
// its exploration PR's head open it), and unmounts it on `onClose`.

export function ExploreNow({ repo, app, onClose }: { repo: string; app: string; onClose: () => void }) {
  const shell = useShell();
  const queryClient = useQueryClient();
  const r = rowOf(useExplorations(), repo, app);
  const [n, setN] = useState(3);
  const [hours, setHours] = useState<number | null>(2);
  const [tonight, setTonight] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => yes.current?.focus(), []);

  const close = () => {
    if (!sending) onClose();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  async function send() {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      // Until when it may go, and the night it stands for: Hono's client loses them, all optional.
      const done: { until?: string; night?: string } = await ok(client.api.explorations[':owner'][':name'][':app'].run.$post({ ...at(repo, app), json: { maxFunctions: n, hours, tonight } }));
      shell.toast(`ronin está levantando ${app} para explorarla${done.until ? ` hasta las ${hhmm(done.until)}` : ''}.${done.night ? ' Esta noche no corre otra.' : ''} La corrida se sigue en Corridas.`);
      // Its runs are read again, the new one among them.
      void queryClient.resetQueries({ queryKey: ['exploration-runs'] });
      explored(repo, app);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        shell.unauthorized(e.message);
        return;
      }
      setSending(false);
      setError(`No se pudo: ${(e as Error).message}`);
    }
  }

  return (
    <div className="scrim" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="xn-t">
        <h2 id="xn-t">Explorar {app} ahora</h2>
        <p className="help">ronin elige las funciones y los charters igual que de noche: primero las nuevas y las que cambiaron, después las marcadas <b>alta</b>, la que hace más tiempo que no se explora, y una al azar. {r?.pr ? `Lo que encuentre se suma al PR #${r.pr.number}.` : 'Si encuentra algo, abre el PR de exploración.'}</p>
        <div className="xn-row">
          <label className="field"><span>Funciones</span><select id="xn-n" value={String(n)} onChange={(e) => setN(Number(e.target.value))}>{[1, 2, 3, 4, 5, 8, 10].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label className="field"><span>Tope de tiempo</span><select id="xn-h" value={hours ? String(hours) : ''} onChange={(e) => setHours(e.target.value ? Number(e.target.value) : null)}><option value="1">1 hora</option><option value="2">2 horas</option><option value="4">4 horas</option><option value="">Sin tope</option></select></label>
        </div>
        <label className="check"><input type="checkbox" id="xn-night" checked={tonight} onChange={(e) => setTonight(e.target.checked)} /><span>Cuenta como la de esta noche<small id="xn-why">{tonight ? 'Esta noche no corre otra de esta app: el límite semanal de Claude es el mismo que usa el trabajo de día.' : 'Esta noche corre otra igual, con otras funciones.'}</small></span></label>
        <p className="help">Usa la cuenta de Claude de {repoShort(repo)}, la misma del trabajo de día. Corre aparte, como de noche, y queda en <i>Corridas</i> a tu nombre.</p>
        <p className="bad" id="xn-err" hidden={!error}>{error ?? ''}</p>
        <div className="foot-d"><button className="btn-s" id="xn-no" onClick={close}>Cancelar</button><button className="btn-s primary" id="xn-yes" ref={yes} disabled={sending} onClick={send}>{sending ? 'Lanzando…' : 'Explorar'}</button></div>
      </div>
    </div>
  );
}
