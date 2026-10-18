# Criterio de bloqueo

"Bloqueado" significa **el agente no puede seguir sin una decisión humana**. Es distinto de "esperando" — un PR esperando review o un CI corriendo no son bloqueos, son parte normal del ciclo y no generan notificación.

## Dispara `ronin:blocked` + email

Los límites se cuentan por PR (con el label `ronin:attempts-N`, salvo el de CI pendiente y las firmas de falla, que viven en `.ronin-state.json`) y se configuran en `.env`; entre paréntesis, el valor por defecto.

- **E2E fallando persistentemente**: ronin distingue entre un `fix-e2e` que no cambió nada y uno que avanzó. Para eso, a cada falla de los checks le saca una firma (`src/core/failure-signature.ts`): las anotaciones `##[error]` del log del job y los tests que fallan, normalizados para que números, duraciones y hashes no cuenten. Bloquea en dos casos:
  - **La misma falla se repite**: la misma firma aparece más de `E2E_RETRY_LIMIT` (2) veces en el PR. Se cuenta aunque el CI haya pasado en el medio, y el email dice qué falla.
  - **No converge**: cada intento falla distinto, pero el PR llega a `E2E_ATTEMPT_HARD_LIMIT` (5) intentos.

  Si no puede leer los checks, cuenta solo los intentos contra `E2E_RETRY_LIMIT`, como antes. Las firmas viven en `.ronin-state.json`: si se pierden, ronin solo tiene más paciencia, porque el tope duro sigue en el label.
- **Feedback de review que no converge**: el PR sigue con *changes requested* sobre su último commit después de `SLICE_ATTEMPT_LIMIT` (3) corridas de `fix-review`. Un pedido que contradice el spec no bloquea por sí solo: si trae una razón concreta, el agente lo aplica; si es ambiguo o de opinión, deja el código como está y responde por qué.
- **CI que nunca termina**: el PR sigue con checks pendientes (sin reportar, o todavía corriendo) durante `CHECKS_PENDING_RETRY_LIMIT` (60) ticks, unas 5 h con el cron cada 5 minutos. Es la red de seguridad contra un workflow que nunca dispara; un CI que solo tarda no llega a esto.
- **Stack sin retarget**: el PR del fondo del stack sigue apuntando a una rama que no es la raíz después de `RETARGET_RETRY_LIMIT` (3) ticks.
- **Excepciones repetidas**: procesar un issue falla con un error no manejado más de `ISSUE_ERROR_RETRY_LIMIT` (3) veces seguidas: un tick que lo procesa sin errores vuelve el contador a cero. Un error pasajero de GitHub o de la red (un 5xx, 429 o 499 de la API, un timeout, una conexión cortada) no cuenta: se reintenta en el tick siguiente. Un error al tomar un spec o un issue asignado bloquea en el momento. Un error al generar una entrada de changelog solo manda el email, sin label: ese release no se vuelve a procesar.
- **Plan vacío**: el issue de tracking no tiene ninguna slice en su checklist, porque el plan nunca llegó a escribirse.
- **Slices huérfanas**: quedan slices sin mergear pero ningún PR abierto (normalmente, un PR se cerró sin mergear), así que nada va a avanzar solo.
- **Falta información** (`RONIN_STATUS: needs-info`): un issue asignado directamente no tiene contexto suficiente para actuar sin adivinar. El agente comenta en el issue qué necesita, el issue queda en `ronin:blocked` y el email avisa que hay preguntas. Se responden comentando en el issue. Lo mismo con un `/spec` que necesita información, que se vuelve a pedir una vez respondido.

## NO dispara bloqueo (estado normal, sin notificación)

- PR abierto esperando review/approval humano — el humano ya sabe que tiene PRs pendientes, no hace falta avisarle de nuevo.
- PR aprobado y en verde esperando que un humano lo mergee.
- CI corriendo o en cola.
- Comentarios de review mecánicos/accionables (el agente los resuelve y sigue).
- Límite de uso de Claude agotado (`ClaudeUsageLimitError`) — la tarea queda como está y se retoma en un tick posterior, cuando vuelve la cuota. Es un estado transitorio, no una decisión pendiente.

## Contenido de la notificación

Cuando se dispara un bloqueo, el email (`src/core/notifier.ts`) va a quien eligió *Bloqueos* de ese repo en Ajustes → Notificaciones del tablero, o a `NOTIFY_TO` si nadie (`docs/DESIGN.md` §19.5), e incluye:

- Link al issue de tracking y, si aplica, al PR afectado
- El motivo concreto (una de las categorías de arriba), en una oración
- Cuando lo hay, un fragmento relevante (p. ej. cuántos intentos lleva el PR contra qué límite), no el log completo

El label `ronin:blocked` y el email salen juntos. El motivo queda en el email, en el log del tick y en el estado local del runner, desde donde lo muestra el tablero mientras el issue siga bloqueado (`docs/DESIGN.md` §15.7). El supervisor no llena todavía la sección "Blocker" del issue de tracking (`templates/tracking-issue.md`). Para retomar, un humano resuelve lo que falta y vuelve a pasar el issue a `ronin:in-progress`, a mano o desde la ficha del issue en el tablero (*Acciones → Responder y destrabar*, que además comenta la respuesta; `docs/DESIGN.md` §15.11).
