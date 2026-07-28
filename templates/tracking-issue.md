<!--
Template usado por el supervisor para generar el issue de tracking de un spec.
Placeholders {{...}} los rellena el agente al crear el issue vía `gh issue create`.
No editar a mano salvo para ajustar el formato del template en sí.
-->

## Spec

[{{spec_title}}]({{spec_repo_url}}/blob/main/{{spec_relative_path}})

## Slices

- [ ] Slice 1: {{slice_1_title}} — PR: _pendiente_
- [ ] Slice 2: {{slice_2_title}} — PR: _pendiente_

<!-- Una línea por slice del plan. El agente marca [x] cuando el PR de esa
     slice se mergea, y reemplaza "_pendiente_" por "#<numero>" apenas abre el PR. -->

## Bloqueo

_(vacío mientras no haya bloqueo)_

<!-- El agente completa esta sección con el motivo concreto y el link relevante
     (PR, log de e2e, comentario de review) en el mismo momento en que aplica
     la label `valeria:blocked`. Nunca dejar la label sin esta sección rellena. -->
