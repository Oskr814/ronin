import { closeIssueNotPlanned, getIssueAssignees } from '../../platform/github/github.js';
import { log } from '../../platform/logger.js';
import { withActiveRepo, type RepoEntry } from '../../platform/agents/repo-context.js';
import { cancelComment } from './issue.js';
import { addEvent, addRoninMessage, CANCELLABLE, getRequest, RequestError, updateRequest, type PortalRequest } from './requests.js';

// The person cancels a request (#114) while nobody took it: before or while
// ronin reads it, around its prototype, or once it's the team's while its
// issue is still unassigned (that issue closes as not planned, saying so).
// Approved, its issue is ronin's: it can't be cancelled anymore. A worker
// still running on it finishes and leaves it as it is
// (updateUnlessCancelled).

export const CANCELLED_REPLY = 'Cancelaste este pedido. Si necesitas algo más, puedes enviar uno nuevo cuando quieras.';
export const TAKEN = 'Alguien del equipo ya tomó este pedido, así que no se puede cancelar desde aquí.';
const NOT_ANYMORE = 'Este pedido ya no se puede cancelar.';

export async function cancelRequest(n: number, entries: () => Promise<RepoEntry[]>): Promise<PortalRequest> {
  const request = await getRequest(n);
  if (!request || !CANCELLABLE.includes(request.status)) throw new RequestError(NOT_ANYMORE);
  if (request.issue) {
    const entry = (await entries()).find((e) => e.productRepo === request.repo);
    if (!entry) throw new RequestError(NOT_ANYMORE);
    await withActiveRepo(entry, async () => {
      if ((await getIssueAssignees(request.issue!.number)).length) throw new RequestError(TAKEN);
      await closeIssueNotPlanned(request.issue!.number, cancelComment(n));
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
  log.info(`portal: la persona canceló el pedido P-${n}${request.issue ? ` (issue #${request.issue.number} cerrado)` : ''}`);
  return cancelled;
}
