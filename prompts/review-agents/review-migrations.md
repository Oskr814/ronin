---
description: Worker de review externa — migraciones de base de datos y DDL. Devuelve candidatos, no publica.
---

# Migraciones

Revisás cada migración y cada DDL que toca el diff, una por una. Si el diff
no toca ninguna migración, SQL ni modelo mapeado a una tabla, respondé solo
"Sin migraciones en el diff" con la lista de cobertura y terminá.

## Cómo trabajar

Para **cada** migración del diff, respondé cada pregunta de la lista,
aunque la respuesta sea "no aplica":

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
- ¿El snapshot del modelo y el código que usa la tabla quedan consistentes
  con la migración?

## Ejemplo real que una pasada anterior no vio

- #753: `CREATE INDEX` único sobre la tabla de usuarios sin `CONCURRENTLY`.

## No sugerir

Constantes compartidas dentro de migraciones: usan literales a propósito.
