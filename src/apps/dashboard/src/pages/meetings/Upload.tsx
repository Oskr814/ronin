import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, client, ok, type MeetingRow } from '@apps/dashboard/src/api.js';
import { refresh, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { MAX_BYTES } from './model.js';

const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);

// The upload dialog: a file, or the text pasted.
export function Upload({ repos, onClose }: { repos: string[]; onClose: () => void }) {
  const shell = useShell();
  const [repo, setRepo] = useState(repos[0] ?? '');
  const [title, setTitle] = useState('');
  const [at, setAt] = useState('');
  const [link, setLink] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ name: string; size: number; data: string } | null>(null);
  const [over, setOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const input = useRef<HTMLInputElement>(null);
  const repoBox = useRef<HTMLSelectElement>(null);
  useEffect(() => repoBox.current?.focus(), []);

  const close = () => {
    if (!sending) onClose();
  };

  const take = (f: File | undefined) => {
    if (!f) return;
    setError(null);
    if (f.size > MAX_BYTES) return setError('El archivo puede pesar hasta 10 MB.');
    const reader = new FileReader();
    reader.onload = () => setFile({ name: f.name, size: f.size, data: String(reader.result) });
    reader.onerror = () => setError('No se pudo leer el archivo.');
    reader.readAsDataURL(f);
  };

  const send = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const body = { repo, title, link, ...(at ? { at: new Date(at).toISOString() } : {}), ...(file ? { file: { name: file.name, data: file.data } } : { text }) };
      // onlyJson, an untyped middleware, hides the route's answer from the client.
      const out = (await ok(client.api.meetings.$post({ json: body }))) as MeetingRow;
      onClose();
      shell.toast(`Listo: subiste las notas como R-${out.number}.`);
      refresh();
      shell.openMeeting(out.number);
    } catch (e) {
      setSending(false);
      if (e instanceof ApiError && e.status === 401) return shell.unauthorized(e.message);
      // The same notes again: a way to the meeting that has them.
      const number = e instanceof ApiError && e.status === 409 ? Number(e.body?.number) || 0 : 0;
      setError(number
        ? <>{e instanceof Error ? e.message : ''} <button className="link" onClick={() => { onClose(); shell.openMeeting(number); }}>Abrir R-{number}</button></>
        : `No se pudo: ${(e as Error).message}`);
    }
  };

  const ext = (file?.name.split('.').pop() ?? '').toUpperCase().slice(0, 4);
  return createPortal(
    <div id="rlayer">
      <div className="scrim" onClick={(e) => e.target === e.currentTarget && close()}>
        <div className="dlg dlg-new" role="dialog" aria-modal="true" aria-labelledby="ru-t">
          <h2 id="ru-t">Subir notas de una reunión</h2>
          <p className="help">ronin propone; nada se crea hasta que alguien lo apruebe. Las notas quedan en el runner, nunca en GitHub.</p>
          <div className="reu-row2">
            <label className="field"><span>Repo</span><select id="ru-repo" ref={repoBox} value={repo} onChange={(e) => setRepo(e.target.value)}>{repos.map((r) => <option key={r}>{r}</option>)}</select></label>
            <label className="field"><span>Fecha (opcional)</span><input id="ru-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>
          </div>
          <label className="field"><span>Título (opcional)</span><input id="ru-title" maxLength={120} autoComplete="off" placeholder="Si lo dejas vacío, sale del archivo o de las notas" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <div id="ru-file">
            {file ? (
              <div className="reu-drop has">
                <span className="fi">{ext}</span><div><span className="nm">{file.name}</span><small>{kb(file.size)}</small></div>
                <button className="btn-s" onClick={() => { setFile(null); if (input.current) input.current.value = ''; }}>Quitar</button>
              </div>
            ) : (
              <button
                className={`reu-drop${over ? ' over' : ''}`}
                onClick={() => input.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }}
              >
                <b>Arrastra el archivo aquí o elígelo</b><span>PDF, Word (.docx), texto o Markdown · hasta 10 MB</span><small>De Google Docs: Archivo → Descargar → PDF o .docx</small>
              </button>
            )}
          </div>
          <input id="ru-input" ref={input} type="file" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" hidden onChange={(e) => take(e.target.files?.[0])} />
          <div id="ru-paste" hidden={Boolean(file)}>
            <div className="reu-or">o pega el texto</div>
            <label className="field"><span className="sr">Texto de las notas</span><textarea id="ru-text" rows={6} placeholder="Las notas tal como están…" value={text} onChange={(e) => setText(e.target.value)} /></label>
          </div>
          <label className="field"><span>Link de la reunión o la grabación (opcional)</span><input id="ru-link" maxLength={500} autoComplete="off" placeholder="https://meet.google.com/…" value={link} onChange={(e) => setLink(e.target.value)} /></label>
          <p className="bad" id="ru-err" hidden={!error}>{error}</p>
          <div className="foot-d">
            <button className="btn-s" id="ru-no" onClick={close}>Cancelar</button>
            <button className="btn-s primary" id="ru-yes" disabled={sending || !repo || (!file && !text.trim())} onClick={send}>{sending ? 'Subiendo…' : 'Subir'}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
