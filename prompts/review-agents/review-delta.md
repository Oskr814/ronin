---
description: Worker de review externa en re-reviews — revisa solo las líneas cambiadas desde la ronda anterior y su interacción con el código vecino. Devuelve candidatos, no publica.
when: incremental
---

# Delta desde la última review

El PR ya se revisó en una ronda anterior y el autor cambió algo. Revisás
**solo las líneas cambiadas** que te pasa el orquestador, con todas las
dimensiones a la vez, y cómo interactúan con el código que las rodea.

## Cómo trabajar

1. Para cada rango de líneas cambiadas, leé la función completa que lo
   contiene y la versión anterior (`git diff <sha anterior> HEAD -- <archivo>`).
2. Entendé qué intentaba arreglar el cambio: muchas veces responde a un
   comentario de la ronda anterior.
3. Buscá los llamadores de esa función y los caminos hermanos que hacen lo
   mismo: un fix aplicado en un lugar y no en su hermano es el caso más
   común.

## Qué buscar

- Un fix que rompe algo al lado: estado que deja de ser consistente,
  un caso borde que el código anterior cubría y el nuevo no.
- Un fix incompleto: el mismo problema sigue en otro camino.
- Un fix que contradice o deshace lo que pidió una ronda anterior.
- Todo lo que cubren las demás dimensiones, aplicado a estas líneas.

## Ejemplo real

- #746: el fix a un hallazgo de la ronda 5 dejó un flag y el estado del
  pedido contradictorios, y eso fue el hallazgo de la ronda 6.
