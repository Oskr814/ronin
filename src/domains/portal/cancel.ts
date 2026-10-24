import { closeIssueNotPlanned, getIssueAssignees } from '@platform/github/github.js';
import { log } from '@platform/logger.js';
import { withActiveRepo, type RepoEntry } from '@platform/agents/repo-context.js';
import { cancelComment } from './issue.js';
import { addEvent, addRoninMessage, CANCELLABLE, getRequest, RequestError, updateRequest, type PortalRequest } from './requests.js';

// The person cancels a request (#114) while nobody took it: before or while
// ronin reads it, around its prototype, or once it's the team's while its
// issue is still unassigned (that issue closes as not planned, saying so).
// Approved, its issue is ronin's: it can't be cancelled anymore. A worker
// still running on it finishes and leaves it as it is
// (updateUnlessClosed). Who took the issue is asked before answering; closing
// it (three calls to GitHub, over two seconds, #411) happens after.

export const CANCELLED_REPLY = 'Cancelaste este pedido. Si necesitas algo más, puedes enviar uno nuevo cuando quieras.';
export const TAKEN = 'Alguien del equipo ya tomó este pedido, así que no se puede cancelar desde aquí.';
const NOT_ANYMORE = 'Este pedido ya no se puede cancelar.';

export async function cancelRequest(n: number, entries: () => Promise<RepoEntry[]>): Promise<PortalRequest> {
  const request = await getRequest(n);
  if (!request || !CANCELLABLE.includes(request.status)) throw new RequestError(NOT_ANYMORE);
  const entry = request.issue ? (await entries()).find((e) => e.productRepo === request.repo) : undefined;
  if (request.issue) {
    if (!entry) throw new RequestError(NOT_ANYMORE);
    await withActiveRepo(entry, async () => {
      if ((await getIssueAssignees(request.issue!.number)).length) throw new RequestError(TAKEN);
    });
  }
  const cancelled = await updateRequest(n, (r) => {
    if (!CANCELLABLE.includes(r.status)) throw new RequestError(NOT_ANYMORE);
    r.status = 'cancelled';
    addEvent(r, { kind: 'cancelled' });
    delete r.worker;
    addRoninMessage(r, CANCELLED_REPLY);
    return r;
  });
  log.info(`portal: la persona canceló el pedido P-${n}`);
  if (request.issue && entry) {
    const issue = request.issue.number;
    void withActiveRepo(entry, () => closeIssueNotPlanned(issue, cancelComment(n)))
      .then(() => log.info(`portal: issue #${issue} del pedido P-${n} cerrado`))
      .catch((error) => log.error(`portal: no se pudo cerrar el issue #${issue} del pedido cancelado P-${n}`, error));
  }
  return cancelled;
}
