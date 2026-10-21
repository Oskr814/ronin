import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { client, ok, type Me } from '../api.js';

// Before entering: the login, the forgotten password, and setting the
// password from an emailed link.

const Seal = () => <div className="seal seal-lg" aria-hidden="true">浪人</div>;

function Messages({ error, info }: { error: string | null; info?: string | null }) {
  return (
    <>
      {error && <p className="msg-bad" role="alert">{error}</p>}
      {info && <p className="msg-ok">{info}</p>}
    </>
  );
}

// The card, with its first empty field focused when it appears.
function Card({ onSubmit, children }: { onSubmit?: (event: FormEvent) => void; children: ReactNode }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const first = form.current?.querySelector('input');
    if (first && !first.value) first.focus();
  }, []);
  return <div className="gate">{onSubmit ? <form className="card" ref={form} onSubmit={onSubmit}>{children}</form> : <div className="card">{children}</div>}</div>;
}

export function Login({ onIn }: { onIn: (me: Me) => void }) {
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const switchTo = (toForgot: boolean) => {
    setForgot(toForgot);
    setError(null);
    setInfo(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (forgot) {
        await ok(client.forgot.$post({ json: { email } }));
        setInfo('Si hay una cuenta con ese correo, te llegará un enlace en unos minutos. Revisa también el correo no deseado.');
      } else {
        onIn(await ok(client.login.$post({ json: { email, password } })));
        return;
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const emailField = (
    <div className="field"><label htmlFor="em">Correo</label><input id="em" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
  );

  if (forgot) {
    return (
      <Card onSubmit={submit} key="forgot">
        <div className="head"><Seal /><h1>¿Olvidaste tu contraseña?</h1><p>Escribe tu correo y te mandamos un enlace para crear una nueva.</p></div>
        {emailField}
        <Messages error={error} info={info} />
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Mandarme el enlace'}</button>
        <div className="foot"><button type="button" className="linkish" onClick={() => switchTo(false)}>Volver a entrar</button></div>
      </Card>
    );
  }
  return (
    <Card onSubmit={submit} key="login">
      <div className="head"><Seal /><h1>Pedidos de ajustes</h1><p>Pide cambios pequeños en tus aplicaciones. Al entrar eliges en cuál.</p></div>
      {emailField}
      <div className="field"><label htmlFor="pw">Contraseña</label><input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
      <Messages error={error} info={info} />
      <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      <div className="foot"><button type="button" className="linkish" onClick={() => switchTo(true)}>¿Olvidaste tu contraseña?</button><span>¿No tienes cuenta? Pídesela al equipo de desarrollo.</span></div>
    </Card>
  );
}

type Link = { name: string; email: string; kind: string };

export function Password({ token, onIn }: { token: string | null; onIn: (me: Me) => void }) {
  // undefined while it's asked; null when the link is no good.
  const [link, setLink] = useState<Link | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('Al enlace le falta una parte. Ábrelo de nuevo desde el correo.');
      setLink(null);
      return;
    }
    ok(client.link.$post({ json: { token } })).then(setLink, (e: Error) => {
      setError(e.message);
      setLink(null);
    });
  }, [token]);

  if (link === undefined) return null;
  if (link === null) {
    return (
      <Card>
        <div className="head"><Seal /><h1>Enlace no válido</h1></div>
        <Messages error={error} />
        <div className="foot"><a className="linkish" href="/">Ir a entrar</a></div>
      </Card>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== again) {
      setError('Las dos contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onIn(await ok(client.password.$post({ json: { token, password } })));
      return;
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const invite = link.kind === 'invite';
  return (
    <Card onSubmit={submit}>
      <div className="head"><Seal /><h1>{invite ? 'Crea tu contraseña' : 'Cambia tu contraseña'}</h1><p>{link.name} · {link.email}</p></div>
      <div className="field"><label htmlFor="pw">Contraseña nueva</label><input id="pw" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} /><small>Al menos 10 caracteres.</small></div>
      <div className="field"><label htmlFor="pw2">Repítela</label><input id="pw2" type="password" autoComplete="new-password" minLength={10} required value={again} onChange={(e) => setAgain(e.target.value)} /></div>
      <Messages error={error} />
      <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Guardando…' : invite ? 'Crear contraseña y entrar' : 'Cambiar contraseña y entrar'}</button>
    </Card>
  );
}
