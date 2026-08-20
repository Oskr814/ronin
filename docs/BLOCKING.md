# Criterio de bloqueo

"Bloqueado" significa **el agente no puede seguir sin una decisión humana**. Es distinto de "esperando" — un PR esperando review o un CI corriendo no son bloqueos, son parte normal del ciclo y no generan notificación.

## Dispara `status:blocked` + email

- **Spec ambiguo**: el paso de planning no puede producir un plan/checklist de slices sin inventar requisitos que no están en el spec.
- **E2E fallando persistentemente**: los tests de Playwright de una slice fallan después de **2 intentos de fix** por el propio agente sobre la misma causa.
- **Conflicto de merge no mecánico**: rebase de una slice contra su base falla con conflictos en lógica (no solo shift de líneas) — resolverlo a ciegas puede introducir un bug que el agente no puede validar solo.
- **Feedback de review que contradice el spec**: un reviewer (humano o Copilot) pide un cambio que va en contra de lo que el spec define explícitamente. El agente no decide unilateralmente desviarse del spec.
- **Loop guard**: se agotan **3 intentos** de abrir un PR mergeable para la misma slice (CI rojo repetido, revert de fixes previos, etc.) sin converger.

## NO dispara bloqueo (estado normal, sin notificación)

- PR abierto esperando review/approval humano — el humano ya sabe que tiene PRs pendientes, no hace falta avisarle de nuevo.
- CI corriendo o en cola.
- Comentarios de review mecánicos/accionables (el agente los resuelve y sigue).
- Cuota/rate-limit de Claude agotada — se maneja con backoff en el supervisor, es un estado transitorio, no una decisión pendiente.

## Contenido de la notificación

Cuando se dispara un bloqueo, el email incluye siempre:

- Link al issue de tracking y al PR/slice afectado (si aplica)
- El motivo concreto (una de las categorías de arriba), en una oración
- El fragmento de log/comentario relevante que causó el bloqueo (no el log completo)

El agente aplica la label `ronin:blocked` **en el mismo momento** en que completa la sección "Bloqueo" del issue (ver `templates/tracking-issue.md`) — nunca una sin la otra, para que el estado en GitHub y el email siempre cuenten la misma historia.
