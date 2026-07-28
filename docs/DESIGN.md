# Diseño

## Problema

El flujo actual para implementar un spec es esencialmente manual más allá de la generación de código:

1. El spec se crea y depura a mano (bien que sea manual — requiere criterio humano).
2. La implementación se hace "one-shot": un agente ejecuta el spec completo en una sola sesión, produciendo PRs de +100 archivos y +1000 líneas — imposibles de revisar bien.
3. Cualquier corrección de diseño/estándar detectada en review vuelve a requerir iteración manual.
4. La parte visual (Claude Design → implementación) es la más difícil de monitorear y garantizar.
5. Si se agota la cuota de Claude, el trabajo se detiene hasta reanudar manualmente.

## Principios de diseño

- **Nunca una sesión continua.** Cada unidad de trabajo (plan, slice, fix de review) corre en una sesión de Claude nueva, para no degradar la ventana de contexto. La continuidad entre sesiones no vive en la memoria del agente, vive en estado externo verificable.
- **GitHub como máquina de estados.** No se construye una base de datos propia para trackear progreso. El estado real de un spec es el estado de su issue/PRs en GitHub. Esto hace que "reanudar tras un corte de cuota" no sea un caso especial — es simplemente la siguiente vuelta del loop leyendo el mismo estado.
- **Autonomía en el descubrimiento, no en el criterio de merge.** El agente decide solo qué spec trabajar y cómo trocearlo, pero **el merge automático de un PR requiere approval explícito** — nunca dispara solo porque el CI está verde. Este gate no es negociable.
- **La revisión humana se mantiene, pero en PRs pequeños.** El review sigue siendo manual (técnica de stacked PRs), la mejora es que cada PR sea revisable en minutos, no horas.

## Arquitectura

### 1. Descubrimiento de specs

Los specs viven en el repo del producto (ej. `docs/superpowers/` en bmedical) con frontmatter:

```yaml
---
status: draft | ready | in-progress | blocked | done
issue: null            # lo rellena el agente al descubrir el spec
---
```

- `draft` / `ready` los controla el humano (marca `ready` cuando terminó de depurar el spec).
- `in-progress` / `blocked` / `done` los controla el agente.
- Una vez que `issue` está seteado, el frontmatter es un espejo — la fuente de verdad es el issue de GitHub, para evitar drift entre dos lugares de estado.

### 2. Mapeo a GitHub

- 1 spec → 1 issue de tracking, con checklist de slices (generado por el paso de planning).
- 1 slice → 1 PR apilado sobre el anterior.
- Estado inferido de GitHub, no de memoria del agente:
  - branch existe → spec empezado
  - PR abierto → slice en curso
  - comentarios sin resolver → ciclo de fix
  - PR **approved** → candidato a merge automático
  - PR merged → siguiente slice

### 2.1 Template del issue de tracking

El body lo genera el agente a partir de [`templates/tracking-issue.md`](../templates/tracking-issue.md): un link al spec, un checklist de slices (una línea por slice, con el PR asociado apenas se abre), y una sección de bloqueo que solo se llena cuando aplica.

El estado en sí **no se infiere parseando el body** — vive en labels, que son consultables directamente vía `gh issue list --label`:

- `valeria` — marca el issue como gestionado por el agente (para poder filtrar sin ambigüedad entre issues del repo).
- `valeria:ready | valeria:in-progress | valeria:blocked | valeria:done` — estado actual, mutuamente excluyente, la swap-ea el agente. Espejo 1:1 del `status` del frontmatter del spec.

El body queda como contexto legible para el humano (qué slice va, qué PR corresponde, por qué está bloqueado); las labels son lo que el supervisor realmente lee para decidir la próxima acción.

### 3. Supervisor (honelab, tmux)

Un proceso supervisor corre en una sesión tmux persistente y en cada tick:

1. Escanea specs con `status: ready` sin `issue` vinculado → crea el issue, dispara una sesión `claude -p` en un worktree nuevo para plan + primera slice.
2. Escanea issues abiertos `in-progress` → decide la próxima acción según el estado real del PR/CI/reviews (implementar siguiente slice, resolver comentarios de Copilot, mergear si está aprobado).
3. Cada acción es una invocación de Claude no interactiva, aislada en su propio worktree, que termina al completar la unidad de trabajo — así nunca se acumula contexto entre tareas.
4. Manejo de cuota: si `claude` sale por rate-limit/cuota, no se reintenta de inmediato — backoff (usar el reset time del error si viene, si no, reintentar más tarde).
5. Bloqueo real (spec ambiguo, e2e fallando tras N intentos, conflicto que requiere juicio humano) → notificación por email, el loop deja ese issue en paz hasta recibir input humano.

Concurrencia: un spec/slice a la vez por seguridad de worktree; specs independientes sí pueden correr en paralelo en worktrees separados.

### 4. Testing y review externo

- E2E: el agente levanta la app y corre flujos con Playwright antes de abrir el PR.
- Review externo: se solicita review de GitHub Copilot sobre el PR; el agente monitorea y resuelve comentarios de forma automática.
- Pipelines: el agente monitorea CI y solo considera un PR "mergeable" cuando CI está verde **y** el PR tiene approval humano explícito.

### 5. Parte visual

Para flujos complejos, el spec incluye un link a un proyecto de Claude Design. El agente lo sincroniza vía MCP (`DesignSync` / skill `/design-sync`) para obtener la propuesta de componentes, en vez de improvisar el diseño visual.

### 6. Notificaciones

Solo se notifica por email en bloqueos reales, no en progreso rutinario (para evitar fatiga de alertas). Requiere una app pequeña con credenciales de Gmail vía variables de entorno, corriendo junto al supervisor.

## Estado actual

Diseño en progreso, sin código todavía. Próximos pasos:

- [ ] Definir el esqueleto del supervisor (script + estructura de tick)
- [x] Definir el template del issue de tracking (checklist de slices) — ver [`templates/tracking-issue.md`](../templates/tracking-issue.md) y §2.1
- [ ] Definir el criterio exacto de "bloqueo" que dispara notificación
- [ ] Prototipo de la app de notificación por email
