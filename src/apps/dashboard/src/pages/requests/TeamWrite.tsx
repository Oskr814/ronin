import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { firstName, type Detail } from './model.js';

// Escribirle a la persona (#353): while the team has the request and until
// it closes, someone with the repo's actions writes to whoever asked, with
// text and images. The person sees it signed «Equipo de desarrollo», in
// the portal and by mail, and can answer; ronin doesn't read either.

const TEAM_HELD = ['awaiting-dev', 'approved', 'fixing', 'big'];
const MAX_IMAGES = 4;
const MAX_BYTES = 5 * 1024 * 1024;

const dataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

export function TeamWrite({ d }: { d: Detail }) {
  const shell = useShell();
  const session = useSession();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!TEAM_HELD.includes(d.status) || !session.can(d.repo, 'acciones')) return null;
  const who = firstName(d.person);

  const add = async (files: File[]) => {
    const next = [...images];
    for (const file of files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return setError('Solo imágenes PNG, JPG, WebP o GIF.');
      if (file.size > MAX_BYTES) return setError('Cada imagen puede pesar hasta 5 MB.');
      if (next.length >= MAX_IMAGES) return setError(`Hasta ${MAX_IMAGES} imágenes por mensaje.`);
      next.push(await dataUrl(file));
    }
    setError(null);
    setImages(next);
  };
  const send = async () => {
    if (sending || (!text.trim() && !images.length)) return;
    setSending(true);
    setError(null);
    try {
      const written = await ok(client.api.requests[':n'].messages.$post({ param: { n: String(d.number) }, json: { text: text.trim(), images } }));
      queryClient.setQueryData(['request', d.number], written);
      setText('');
      setImages([]);
      shell.toast(`Le escribiste a ${who}: le llega en el portal y por correo.`);
    } catch (e) {
      setSending(false);
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      setError(`No se pudo: ${(e as Error).message}`);
    }
    setSending(false);
  };

  return (
    <div className="pd-tw">
      <h4>Escribirle a {who}</h4>
      <textarea rows={3} maxLength={4000} placeholder={`Una pregunta, un aviso… ${who} lo ve firmado «Equipo de desarrollo».`} value={text} disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            void add(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
        }} />
      {images.length > 0 && <div className="pend">{images.map((src, i) => <span key={i}><img src={src} alt={`Imagen adjunta ${i + 1}`} /><button aria-label="Quitar imagen" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button></span>)}</div>}
      <div className="cf">
        <span className="m">Le llega en el portal y por correo{d.issue ? `, y queda copiado en el issue #${d.issue.number}` : ''}. ronin no lo lee: el pedido sigue donde está.</span>
        <label className="btn-s">Adjuntar<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { void add([...(e.target.files ?? [])]); e.target.value = ''; }} /></label>
        <button className="btn-s primary" disabled={sending || (!text.trim() && !images.length)} onClick={() => void send()}>{sending ? 'Enviando…' : `Enviar a ${who}`}</button>
      </div>
      {error && <p className="bad">{error}</p>}
    </div>
  );
}
