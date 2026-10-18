import { describe, it, expect } from 'vitest';
import { bigRequestMail, closedMail, deployedMail, doneMail, linkMail, prototypeMail, replyMail, teamPrMail, teamRequestMail } from './mail.js';
import type { PortalUser } from './accounts.js';
import type { PortalRequest } from './requests.js';

const user: PortalUser = { id: 'u1', email: 'mf@x.com', name: 'María Fernández', grants: [], disabled: false, sessionVersion: 1, createdAt: '', createdBy: 'oskr814' };
const request = (over: Partial<PortalRequest> = {}): PortalRequest => ({
  number: 31, userId: 'u1', repo: 'redmotos/shoppingcart', app: 'backoffice', title: 'Abrir la ficha del cliente', status: 'asking', questions: 1,
  messages: [
    { id: 1, from: 'person', text: 'Quiero <b>abrir</b> la ficha', images: ['1-1.png'], at: '2026-10-17T10:00:00Z' },
    { id: 2, from: 'ronin', text: '¿En las tres pantallas?', images: [], at: '2026-10-17T10:02:00Z' },
  ],
  createdAt: '', updatedAt: '', ...over,
});
const URL = 'https://ronin-agent.example.com';

describe('portal mails', () => {
  it("a question carries ronin's reply and the link to answer it", () => {
    const mail = replyMail(request(), user, URL);
    expect(mail).toMatchObject({ to: 'mf@x.com', subject: 'ronin te hizo una pregunta: Abrir la ficha del cliente' });
    expect(mail.text).toContain('¿En las tres pantallas?');
    expect(mail.text).toContain(`${URL}/p/31`);
    expect(replyMail(request({ status: 'minor' }), user, URL).subject).toMatch(/^ronin te respondió/);
  });

  it('a big one tells the person the team has it', () => {
    const mail = bigRequestMail(request({ status: 'big' }), user, URL);
    expect(mail.subject).toBe('Recibimos tu pedido: Abrir la ficha del cliente');
    expect(mail.text).toMatch(/equipo de desarrollo/);
  });

  it("the team's mail has the verdict, the conversation and where the images are", () => {
    const mail = teamRequestMail(request({ status: 'minor', verdict: { kind: 'minor', proposal: 'Un enlace', instruction: 'x', summary: 'ClientInfoPanel.tsx', at: '' } }), user, 'team@x.com', '/data/requests/31/img');
    expect(mail).toMatchObject({ to: 'team@x.com', subject: '[ronin] Pedido P-31 del portal (ajuste chico): Abrir la ficha del cliente' });
    for (const part of ['María Fernández <mf@x.com>', 'Propuesta: Un enlace', 'ClientInfoPanel.tsx', '¿En las tres pantallas?', '/data/requests/31/img']) expect(mail.text).toContain(part);
  });

  it('the prototype mail sends the person to the portal, where the images are', () => {
    const mail = prototypeMail(request({ status: 'proposed' }), user, URL);
    expect(mail.subject).toBe('Tu prototipo está listo: Abrir la ficha del cliente');
    expect(mail.text).toContain(`${URL}/p/31`);
    expect(mail.html).not.toContain('<img');
  });

  it("an approved or turned-down prototype tells the team, with the last prototype and its diff", () => {
    const prototypes = [{ round: 1, summary: 'Hace un Link', patch: '1.diff', messageId: 3, at: '' }];
    const verdict = { kind: 'minor' as const, proposal: 'Un enlace', instruction: 'x', summary: 'ClientInfoPanel.tsx', at: '' };
    const approved = teamRequestMail(request({ status: 'approved', verdict, prototypes, decision: { kind: 'approved', at: '' } }), user, 'team@x.com', '/data/requests/31', '+<Link>');
    expect(approved.subject).toBe('[ronin] Pedido P-31 del portal (prototipo aprobado): Abrir la ficha del cliente');
    for (const part of ['La persona vio el prototipo: prototipo aprobado.', 'El prototipo 1:\nHace un Link', 'Diff del prototipo 1:', '+<Link>', 'los diffs de los prototipos']) expect(approved.text).toContain(part);
    const rejected = teamRequestMail(request({ status: 'big', verdict: { ...verdict, kind: 'big', reason: 'La persona no aprobó el prototipo.' }, prototypes, decision: { kind: 'rejected', at: '' } }), user, 'team@x.com', '/data/requests/31');
    expect(rejected.subject).toContain('(prototipo no aprobado)');
    expect(bigRequestMail(request({ status: 'big', decision: { kind: 'rejected', at: '' } }), user, URL).text).toContain('lo que conversamos sobre el prototipo');
  });

  it('tells the person when it merged, and the team when its PR waits for them', () => {
    expect(doneMail(request({ status: 'done' }), user, URL)).toMatchObject({ to: 'mf@x.com', subject: 'Listo, sale en la próxima actualización: Abrir la ficha del cliente' });
    const team = teamPrMail(request({ status: 'approved', issue: { number: 9, url: 'https://github.com/x/y/issues/9' } }), user, 'team@x.com', 'https://github.com/x/y/pull/10');
    expect(team.subject).toBe('[ronin] PR para aprobar: pedido P-31 del portal (Abrir la ficha del cliente)');
    for (const part of ['https://github.com/x/y/pull/10', 'ronin:auto-merge', 'https://github.com/x/y/issues/9']) expect(team.text).toContain(part);
  });

  it("tells the person when the team closed its issue, solved or not for now", () => {
    expect(closedMail(request({ status: 'resolved' }), user, URL)).toMatchObject({ subject: 'Resuelto: Abrir la ficha del cliente', text: expect.stringContaining('resolvió tu pedido P-31') });
    expect(closedMail(request({ status: 'declined' }), user, URL)).toMatchObject({ subject: 'Revisamos tu pedido: Abrir la ficha del cliente', text: expect.stringContaining('decidió no hacerlo por ahora') });
  });

  it('escapes what people wrote in the HTML', () => {
    expect(linkMail({ ...user, name: '<script>x</script>' }, 'invite', `${URL}/contrasena#t=abc`, URL, []).html).not.toContain('<script>');
    expect(replyMail(request({ messages: [{ id: 2, from: 'ronin', text: '<img src=x onerror=alert(1)>', images: [], at: '' }] }), user, URL).html).not.toContain('<img');
  });
});

describe('deployedMail', () => {
  it('tells one request as before, and several in one mail with a link to each', () => {
    const one = deployedMail([request({ status: 'done' })], user, 'https://portal.example.com');
    expect(one.subject).toBe('Ya está en la aplicación: Abrir la ficha del cliente');
    expect(one.text).toContain('El cambio de tu pedido P-31 ("Abrir la ficha del cliente") ya está en la aplicación.');
    const two = deployedMail([request({ status: 'done' }), request({ number: 32, title: 'El <total> visible', bug: { steps: 'Abrir el total', reproductions: [] } })], user, 'https://portal.example.com');
    expect(two).toMatchObject({ to: 'mf@x.com', subject: 'Ya están en la aplicación: 2 de tus pedidos' });
    expect(two.text).toContain('Hola María,');
    expect(two.text).toContain('- P-31: "Abrir la ficha del cliente"\n  https://portal.example.com/p/31');
    expect(two.text).toContain('- P-32: el arreglo del error "El <total> visible"\n  https://portal.example.com/p/32');
    expect(two.html).toContain('">P-32</a>: el arreglo del error &quot;El &lt;total&gt; visible&quot;');
    expect(two.html).toContain('Ver mis pedidos');
  });
});
