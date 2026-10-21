import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useBusy } from './busy.js';
import { attach } from './images.js';

// What the person is writing, with its images: kept by the page that shows
// the composer, so it survives the composer giving way to a confirmation.
export interface Draft {
  text: string;
  pending: string[];
  setText: (text: string) => void;
  setPending: (pending: string[]) => void;
  clear: () => void;
}

export function useDraft(): Draft {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  useBusy(Boolean(text.trim() || pending.length));
  return { text, pending, setText, setPending, clear: () => { setText(''); setPending([]); } };
}

export function ComposerFrame({ children, error }: { children: ReactNode; error?: string | null }) {
  return <div className="composer"><div className="composer-in">{children}{error && <p className="msg-bad" role="alert">{error}</p>}</div></div>;
}

// The box to write in: Enter sends, Shift+Enter is a new line; images are
// pasted, dropped or picked.
export function Composer({ draft, placeholder, label, note, above, sending, error, onSend, onError, focus }: {
  draft: Draft;
  placeholder: string;
  label: string;
  note?: string;
  above?: ReactNode;
  sending: boolean;
  error: string | null;
  onSend: () => void;
  onError: (error: string | null) => void;
  focus?: boolean;
}) {
  const [drag, setDrag] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) area.current?.focus();
  }, [focus]);

  const add = async (files: File[]) => {
    const { pending, error: problem } = await attach(draft.pending, files);
    draft.setPending(pending);
    onError(problem);
  };

  return (
    <ComposerFrame error={error}>
      {above}
      <div className={`box ${drag ? 'drag' : ''}`} id="box"
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void add([...e.dataTransfer.files]); }}>
        {draft.pending.length > 0 && (
          <div className="pend">
            {draft.pending.map((src, i) => (
              <div key={i}><img src={src} alt={`Imagen adjunta ${i + 1}`} /><button aria-label="Quitar imagen" onClick={() => draft.setPending(draft.pending.filter((_, j) => j !== i))}>×</button></div>
            ))}
          </div>
        )}
        <textarea id="ta" ref={area} rows={2} maxLength={4000} placeholder={placeholder} disabled={sending} value={draft.text}
          onChange={(e) => draft.setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void add(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }} />
        <div className="box-f">
          <label className="icon-btn" title="Adjuntar imágenes">
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { void add([...(e.target.files ?? [])]); e.target.value = ''; }} />
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-8 8" /></svg>
            <span className="sr">Adjuntar imágenes</span>
          </label>
          <span className="hint">{note || 'Puedes pegar o arrastrar capturas (hasta 4)'}</span>
          <button className="btn primary" disabled={sending} onClick={onSend}>{sending ? 'Enviando…' : label}</button>
        </div>
      </div>
    </ComposerFrame>
  );
}
