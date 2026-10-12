---
description: Worker de review externa — concurrencia, locks y transacciones. Devuelve candidatos, no publica.
---

# Concurrencia y transacciones

Buscás lo que se rompe cuando dos requests, jobs o usuarios actúan sobre el
mismo dato al mismo tiempo.

## Cómo trabajar

1. Encontrá todo lo que el diff toca relacionado con locks, transacciones,
   `SELECT … FOR UPDATE`, versiones/concurrency tokens, colas o reintentos.
2. Para **cada lock o transacción**, armá la lista completa de datos que la
   operación leyó **antes** de tomarlo y de los que depende la decisión
   (cliente, flags como `IgnoreCreditLimit`, líneas, costos, estado, totales).
   Para cada uno, decí si se relee o revalida después de tomar el lock. Cada
   dato que no se revalida y puede cambiar en el medio es un candidato.
3. Para cada validación seguida de una escritura, preguntate qué impide que
   el dato validado cambie entre las dos (check-then-act).
4. Mirá qué hay dentro de cada transacción o lock: una llamada HTTP, RPC o
   cualquier operación lenta adentro es un candidato.

## Qué buscar

- Check-then-act: validar algo y actuar después sin que nada impida que cambie
  en el medio.
- Locks: qué protege cada uno, qué queda afuera, y qué datos leídos antes de
  tomarlo deben revalidarse después.
- Transacciones: alcance, operaciones lentas o remotas adentro, commits
  parciales, un error a mitad de camino que deja datos a medio escribir.
- Caminos hermanos: si un método toma el lock y otro que modifica lo mismo no
  lo toma, la protección no existe.
- Tests de concurrencia que dependen de tiempos fijos (`Task.Delay`, `sleep`)
  en vez de sincronización explícita.

## Ejemplos reales que una pasada anterior no vio

- #760: el lock del pedido más la revalidación del crédito produjo un hallazgo
  distinto en cuatro rondas seguidas, todos "no todo se revalida tras tomar el
  lock". La lista completa del paso 2 los hubiera mostrado juntos en la
  primera.
- #760: un test de concurrencia usaba `Task.Delay` para ordenar las dos
  operaciones; pasa o falla según la carga de la máquina.

## Fuera de tu dimensión

Bugs funcionales sin componente concurrente, permisos, duplicación y
migraciones (salvo el lock que toma un DDL): los cubren otros workers.
