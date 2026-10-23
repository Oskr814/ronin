import { config } from '@platform/config/config.js';
import { seal, unseal } from '@platform/crypto/sealed.js';
import { log } from '@platform/logger.js';
import { getUser } from './accounts.js';
import { closedReply } from './follow.js';
import { launchPortalWorker } from './launch.js';
import { closedMail } from './mail.js';
import { sendPortalMails } from './notify.js';
import { addEvent, addRoninMessage, RequestError, updateRequest, type DevDecisionKind, type PortalRequest } from './requests.js';

// A dev decides a request before ronin makes it (#353): a prototype the
// person approved, or a reported error's small fix (#137), waits in
// 'awaiting-dev' until someone of the team, from its page on the tablero:
//   - deploy: ronin opens the issue and the PR, approves the PR as the dev
//     (follow.ts, with their token sealed here) and merges it on green CI;
//   - review: ronin opens the issue and the PR, which waits for a dev's
//     approval, as before;
//   - decline: the request closes with the reason, which the person gets in
//     those words; no issue.

const MAX_REASON = 2000;
// What the dev's token is sealed for (platform/crypto/sealed.ts).
const PURPOSE = 'dev-decision';

export interface DevDecisionInput {
  decision: DevDecisionKind;
  // Why not, for the person: required declining it.
  reason?: string;
  // Who decides (their GitHub login) and, deploying it, their token.
  by: string;
  token?: string;
}

export function parseDevDecision(body: Record<string, unknown>): Pick<DevDecisionInput, 'decision' | 'reason'> {
  const decision = body.decision;
  if (decision !== 'deploy' && decision !== 'review' && decision !== 'decline') throw new RequestError('decision: deploy, review o decline');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (decision === 'decline' && !reason) throw new RequestError('Escribe el motivo: le llega a la persona.');
  if (reason.length > MAX_REASON) throw new RequestError(`El motivo puede tener hasta ${MAX_REASON} caracteres.`);
  return { decision, ...(reason ? { reason } : {}) };
}

export async function devDecide(n: number, input: DevDecisionInput, launch = launchPortalWorker): Promise<PortalRequest> {
  if (input.decision === 'deploy' && !input.token) throw new RequestError('Hace falta tu sesión de GitHub para aprobar el PR a tu nombre.');
  const at = new Date();
  const decided = await updateRequest(n, (r) => {
    if (r.status !== 'awaiting-dev') throw new RequestError('Este pedido ya no espera la decisión del equipo.');
    r.devDecision = {
      kind: input.decision,
      by: input.by,
      at: at.toISOString(),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.decision === 'deploy' ? { token: seal(input.token!, config.dashboard.sessionSecret, PURPOSE) } : {}),
    };
    addEvent(r, { kind: 'dev-decided', decision: input.decision, by: input.by }, at);
    if (input.decision === 'decline') {
      r.status = 'declined';
      r.closeNote = { text: input.reason!, by: input.by, at: at.toISOString() };
      addRoninMessage(r, closedReply('declined', input.reason!), at);
      addEvent(r, { kind: 'closed', status: 'declined' }, at);
    } else r.status = r.bug ? 'fixing' : 'approved';
    return r;
  });
  log.info(`portal: ${input.by} decidió ${input.decision} el pedido P-${n}`);
  if (decided.status === 'declined') {
    const user = await getUser(decided.userId);
    if (user) await sendPortalMails(decided, [closedMail(decided, user, config.portal.url)]);
  } else await launch(n);
  return decided;
}

// The token of the dev who chose to deploy it, while ronin still needs it;
// null once used, or when it doesn't open (another secret).
export const deciderToken = (r: PortalRequest): string | null => (r.devDecision?.token ? unseal(r.devDecision.token, config.dashboard.sessionSecret, PURPOSE) : null);

// Used, or useless: it's dropped from the request.
export async function dropDeciderToken(n: number): Promise<void> {
  await updateRequest(n, (r) => {
    if (r.devDecision) delete r.devDecision.token;
  });
}

