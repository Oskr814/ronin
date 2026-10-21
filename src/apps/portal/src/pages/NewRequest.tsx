import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { client, ended, ok, type App, type Me } from '../api.js';
import { MenuButton } from '../components/MenuButton.js';
import { useBusy } from '../lib/busy.js';
import { Composer, useDraft } from '../components/Composer.js';
import { left } from '../lib/text.js';

const key = (a: App) => `${a.repo}:${a.app}`;

// A new request: the app it's for, among the ones the person has, and what
// they need.
export function NewRequest({ me, flash, onMenu, onSent }: { me: Me; flash: string | null; onMenu: () => void; onSent: (n: number) => void }) {
  const queryClient = useQueryClient();
  const draft = useDraft();
  const [picked, setPicked] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(flash);
  useBusy(sending);

  const apps = me.apps;
  const app = apps.find((a) => key(a) === picked) ?? apps[0];
  const remaining = Math.max(0, me.today.limit - me.today.used);

  const send = async () => {
    if (sending || !app || (!draft.text.trim() && !draft.pending.length)) return;
    setSending(true);
    setError(null);
    try {
      const d = await ok(client.requests.$post({ json: { repo: app.repo, app: app.app, text: draft.text.trim(), images: draft.pending } }));
      draft.clear();
      queryClient.setQueryData(['request', d.number], d);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
      onSent(d.number);
      return;
    } catch (e) {
      if (!ended(e)) setError((e as Error).message);
    }
    setSending(false);
  };

  return (
    <>
      <div className="top"><MenuButton onClick={onMenu} /><h2>Nuevo pedido</h2></div>
      <div className="content"><div className="content-in">
        {apps.length ? (
          <>
            <h3>¿En qué aplicación es el cambio?</h3>
            <p>Solo ves las que el equipo te habilitó.</p>
            <div className="projects">
              {apps.map((a) => (
                <button key={key(a)} className="proj" aria-pressed={a === app} onClick={() => setPicked(key(a))}>
                  <span className="org">{a.org}</span><b>{a.name}</b>{a.description && <span>{a.description}</span>}
                </button>
              ))}
            </div>
            <div className="note"><b>Qué se puede pedir aquí:</b> ajustes chicos sobre lo que ya existe: un texto, un enlace, un dato que falta en una pantalla, algo que se ve mal en el teléfono. También puedes reportar algo que no funciona: ronin intenta reproducirlo.
              Lo que sea un proyecto o una función nueva lo recibe el equipo de desarrollo, y te avisamos cuando esté resuelto.</div>
            <ul className="tips"><li>Cuenta qué quieres cambiar y en qué pantalla.</li><li>Si es algo que no funciona, cuenta qué hiciste, qué esperabas y qué pasó.</li><li>Pega o arrastra capturas: ayudan mucho.</li><li>ronin te puede hacer preguntas antes de proponer el cambio.</li></ul>
          </>
        ) : (
          <>
            <h3>Todavía no tienes aplicaciones habilitadas</h3>
            <p>Pídele al equipo de desarrollo que te habilite las aplicaciones en las que necesitas pedir ajustes.</p>
          </>
        )}
      </div></div>
      {!apps.length ? null
        : remaining === 0 ? <div className="closed-bar">Llegaste al tope de {me.today.limit} pedidos por hoy. Mañana puedes enviar más.</div>
          : <Composer draft={draft} placeholder="Describe el cambio que necesitas…" label="Enviar pedido" note={`${left(remaining, 'pedido', 'pedidos')} por hoy · puedes pegar o arrastrar capturas`}
            sending={sending} error={error} onSend={send} onError={setError} />}
    </>
  );
}
