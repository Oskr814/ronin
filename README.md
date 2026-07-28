# ValerIA

> *Del latín "valere" — estar sano, ser fuerte.*

Orquestación de agentes autónomos para desarrollo dirigido por specs. Nace del flujo de trabajo de [bmedical](https://github.com/Bmedical/bmedical), pero es independiente del monorepo para poder versionarse, iterar y compartirse con otros equipos/devs sin acoplarse al ciclo de release del producto.

## Estado

🚧 Fase de diseño. Todavía no hay código — ver [`docs/DESIGN.md`](docs/DESIGN.md) para la arquitectura propuesta y las decisiones tomadas hasta ahora.

## Objetivo

Reducir el cuello de botella de PRs gigantes (+100 archivos) generados por implementación "one-shot" de specs, dándole al agente autonomía para:

- Descubrir specs listos para implementar (sin intervención manual por spec)
- Trocear el trabajo en slices pequeños y revisables (PRs apilados)
- Correr tests e2e (Playwright) y pedir review externo (GitHub Copilot) por sí mismo
- Reanudar automáticamente tras cortes de cuota, sin sesión continua ni intervención humana
- Escalar bloqueos reales a un humano (notificación por email) en vez de improvisar
