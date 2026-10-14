# Criterio de review externa

Este archivo define qué busca ronin al revisar un PR externo y cómo clasifica
lo que encuentra. Se lee en cada corrida (no hace falta `pnpm build` para que
un cambio aplique) y cada hallazgo publicado registra el hash de la versión
usada, junto con la de los agentes. Ajustarlo es un PR de markdown — ver
`docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md`.

## Dimensiones

Cada dimensión la revisa un agente especializado, definido en
`prompts/review-agents/<nombre>.md`: qué busca, cómo recorre el diff y
ejemplos reales. Este archivo tiene lo común a todos (tipos, origen,
severidad, clases sistémicas y lo que no se marca), que ronin agrega al final
de cada agente.

## Tipos

Cada hallazgo tiene un tipo según la acción que le pide a quien lo lee.

- **bug** (🐞 Defecto) — hay un escenario de falla concreto: dado un estado,
  cuando pasa algo, el sistema hace X en vez de Y. Se acepta o se descarta.
- **decision** (❓ Decisión) — el comportamiento puede ser intencional. Es
  **obligatorio** usar este tipo cuando un test, un comentario, el título o el
  body del PR sugieren que lo es; citar esa evidencia. Se redacta como una
  pregunta de sí o no. También es el tipo correcto cuando hay más de un
  arreglo razonable y elegir entre ellos es una decisión de diseño.
- **improvement** (🧹 Mejora) — smell, duplicación, estilo, legibilidad. Es
  opcional por definición.

## Origen

Cada hallazgo dice si lo trae el PR, comparando contra el merge base:

- **new** — el PR introduce el problema.
- **worsened** — el problema ya existía, pero el PR lo hace más probable o
  más grave. Decir cómo. Es **worsened** siempre que el PR quite o debilite
  una protección que lo cubría (una validación, un lock, una recarga), deje
  ese punto como la única barrera, o modifique el código donde ocurre.
- **preexisting** — el PR no toca ni el código del problema ni ninguna de sus
  protecciones; el riesgo es exactamente el mismo que antes. Se publica como
  **minor** (🟡), como contexto, sin importar los pisos. Si la nota necesita
  un "pero el PR…", no es preexisting.

Un problema que ya existía nunca se presenta como si lo hubiera traído el PR:
el escenario elegido tiene que mostrar lo que el PR cambió.

## Severidad

- **critical** (🔴) — pérdida o corrupción de datos, agujero de seguridad,
  bypass de una regla de negocio, caída en un camino común. Ejemplo: una operación
  que saltea un límite o una validación por un camino distinto al principal.
- **important** (🟠) — bug real en un camino menos común, regresión de
  contrato, problema operativo concreto. Ejemplo: un endpoint que devolvía 400
  ante un error de validación ahora devuelve 500.
- **minor** (🟡) — no rompe nada hoy: robustez, mantenibilidad, tests
  frágiles. Ejemplo: una constante duplicada en dos DTOs.

### Pisos

La severidad nunca puede quedar por debajo de estos pisos:

- Bypass de una regla de negocio (permisos, límites, precios, saldos) →
  **critical**.
- Artefacto generado roto (XML, migración, build) → al menos **important**.
- Cambio de contrato de API observable por un cliente (código HTTP, forma de
  la respuesta) → al menos **important**.
- Chequeo de autorización o de rol ausente en un camino cuando un camino
  hermano (otro endpoint, otra server action, otra variante del mismo método)
  sí lo hace → tipo **bug**, al menos **important**; **critical** si expone
  datos de otro usuario o de otro tenant, o permite una operación que el rol no debería poder
  hacer. Nunca **improvement**.
- Datos que se pierden, se truncan o se omiten sin que el usuario se entere
  (un límite fijo de filas sin paginar, registros que se descartan ante un
  error) → al menos **important**.
- DDL que bloquea una tabla existente en producción (ver "Migraciones") → al
  menos **important**.

## Clases sistémicas

Cuando un hallazgo es una instancia de alguna de estas clases, buscar **todas**
las instancias de la misma clase en el PR y reportar **un único** hallazgo con
todas las ubicaciones y el arreglo de fondo. "La misma clase" es el mismo
mecanismo con el mismo arreglo; mecanismos distintos, aunque estén
relacionados, son hallazgos separados, para que cada uno se acepte o se
descarte por su cuenta:

- Check-then-act y carreras.
- Una validación que se puede saltear por algún camino.
- Datos no revalidados tras tomar un lock: enumerar todos los datos leídos
  antes del lock de los que depende la decisión (la entidad padre,
  flags que saltean una regla, ítems, montos, estado) y decir cuáles se revalidan y
  cuáles no. Cada dato no revalidado con un arreglo propio es un hallazgo; el
  mismo dato sin revalidar en varios métodos es uno solo.
- Un chequeo de autorización o de rol presente en un endpoint y ausente en sus
  hermanos.

## No marcar

Patrones que no se reportan. Esta sección crece con el ajuste periódico del
criterio.

- No sugerir constantes compartidas dentro de migraciones: las migraciones son
  snapshots inmutables y usan literales.
- No reportar como defecto un comportamiento que un test del propio PR
  documenta como esperado: si parece incorrecto, es una **decision**.
