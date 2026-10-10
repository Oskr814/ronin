# Criterio de review externa

Este archivo define qué busca ronin al revisar un PR externo y cómo clasifica
lo que encuentra. Se lee en cada corrida (no hace falta `pnpm build` para que
un cambio aplique) y cada hallazgo publicado registra el hash de la versión
usada. Ajustarlo es un PR de markdown — ver
`docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md`.

## Dimensiones

Cada dimensión la revisa un subagente propio, sobre el diff completo del PR y
con acceso al resto del repositorio.

### Correctitud y bugs

- Lógica que no hace lo que el título, el body o los tests del PR dicen que
  hace.
- Casos borde: colecciones vacías, nulos, límites, errores de conversión,
  zonas horarias, redondeo de montos.
- Manejo de errores: excepciones tragadas, errores que cambian de código HTTP
  (400 ↔ 500), mensajes que se pierden.
- Cambios de contrato: firma pública, forma de un DTO o respuesta de API,
  comportamiento del que dependen otros llamadores del repo.
- Artefactos generados o de configuración (XML de documentación, migraciones,
  archivos de build) que quedan rotos o inconsistentes con el código.

### Concurrencia y transacciones

- Check-then-act: validar algo y actuar después sin que nada impida que cambie
  en el medio.
- Locks: qué protege cada uno, qué queda afuera, y **qué datos leídos antes de
  tomar el lock deben revalidarse después**.
- Transacciones: alcance, operaciones lentas o remotas (llamadas HTTP, RPC)
  dentro de una transacción o de un lock, commits parciales.
- Tests de concurrencia que dependen de tiempos fijos (`Task.Delay`,
  `sleep`) en vez de sincronización explícita.

### Seguridad

- Autorización: endpoints o caminos que no verifican rol, dueño o permiso, en
  especial cuando un endpoint hermano sí lo hace.
- Validación de entrada, inyección (SQL, comandos, rutas), datos sensibles en
  logs o respuestas.
- Reglas de negocio con impacto económico (crédito, precios, descuentos,
  stock) que se pueden saltear por algún camino.

### Cobertura de tests

- Caminos nuevos o modificados sin ningún test que los ejercite, en
  particular los de error y los de concurrencia.
- Tests que pasan sin verificar el comportamiento que dicen probar.
- Un camino hermano del que sí se testeó (otro endpoint, otra variante del
  mismo método) que comparte la lógica nueva y queda sin cubrir.

### Duplicación y code smells

- Lógica equivalente que ya existe en otro lugar del repo y podría
  reutilizarse.
- Duplicación introducida dentro del propio PR.
- Funciones o clases que acumulan responsabilidades, condicionales difíciles
  de seguir, nombres engañosos.

### Migraciones

Aplicar esta lista a **cada** migración que toque el diff, una por una, aunque
el resto del PR no tenga nada de base de datos:

- ¿Crea un índice sobre una tabla existente sin `CONCURRENTLY`? En PostgreSQL
  eso bloquea las escrituras sobre la tabla mientras se construye. Si la
  migración corre dentro de una transacción (el default de EF Core),
  `CONCURRENTLY` no se puede usar ahí: hay que sacarla de la transacción.
- ¿Hace un `ALTER TABLE` que reescribe la tabla o toma un lock exclusivo
  largo (cambiar el tipo de una columna, agregar una columna `NOT NULL` con
  default volátil, agregar una constraint sin `NOT VALID`)?
- ¿Puede fallar con los datos que ya hay en producción (unicidad sobre datos
  duplicados, `NOT NULL` sobre columnas con nulos)? ¿Qué pasa con el
  despliegue si falla?
- ¿El `Down` deshace exactamente lo que hace el `Up`, y es idempotente como
  las demás migraciones del repo?

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

## Severidad

- **critical** (🔴) — pérdida o corrupción de datos, agujero de seguridad,
  bypass de una regla de negocio, caída en un camino común. Ejemplo: agregar
  líneas a un pedido sin validar el crédito del cliente.
- **important** (🟠) — bug real en un camino menos común, regresión de
  contrato, problema operativo concreto. Ejemplo: un endpoint que devolvía 400
  ante un error de validación ahora devuelve 500.
- **minor** (🟡) — no rompe nada hoy: robustez, mantenibilidad, tests
  frágiles. Ejemplo: una constante duplicada en dos DTOs.

### Pisos

La severidad nunca puede quedar por debajo de estos pisos:

- Bypass de una regla de negocio (crédito, permisos, precios, stock) →
  **critical**.
- Artefacto generado roto (XML, migración, build) → al menos **important**.
- Cambio de contrato de API observable por un cliente (código HTTP, forma de
  la respuesta) → al menos **important**.
- Chequeo de autorización o de rol ausente en un camino cuando un camino
  hermano (otro endpoint, otra server action, otra variante del mismo método)
  sí lo hace → tipo **bug**, al menos **important**; **critical** si expone
  datos de otro cliente o permite una operación que el rol no debería poder
  hacer. Nunca **improvement**.
- Datos que se pierden, se truncan o se omiten sin que el usuario se entere
  (un límite fijo de filas sin paginar, registros que se descartan ante un
  error) → al menos **important**.
- DDL que bloquea una tabla existente en producción (ver "Migraciones") → al
  menos **important**.

## Clases sistémicas

Cuando un hallazgo es una instancia de alguna de estas clases, buscar **todas**
las instancias de la misma clase en el PR y reportar **un único** hallazgo con
todas las ubicaciones y el arreglo de fondo:

- Check-then-act y carreras.
- Una validación que se puede saltear por algún camino.
- Datos no revalidados tras tomar un lock: enumerar todos los datos leídos
  antes del lock de los que depende la decisión (cliente, flags como
  `IgnoreCreditLimit`, líneas, costos, estado) y decir cuáles se revalidan y
  cuáles no.
- Un chequeo de autorización o de rol presente en un endpoint y ausente en sus
  hermanos.

## No marcar

Patrones que no se reportan. Esta sección crece con el ajuste periódico del
criterio.

- No sugerir constantes compartidas dentro de migraciones: las migraciones son
  snapshots inmutables y usan literales.
- No reportar como defecto un comportamiento que un test del propio PR
  documenta como esperado: si parece incorrecto, es una **decision**.
