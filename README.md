# ValerIA

> *Del latín "valere" — estar sano, ser fuerte.*

Orquestación de agentes autónomos para desarrollo dirigido por specs. Nace del flujo de trabajo de [bmedical](https://github.com/Bmedical/bmedical), pero es independiente del monorepo para poder versionarse, iterar y compartirse con otros equipos/devs sin acoplarse al ciclo de release del producto.

## Estado

🚧 Supervisor funcional (`pnpm tick`), verificado en un dry run real de punta a punta. Ver [`docs/DESIGN.md`](docs/DESIGN.md) para la arquitectura completa y las decisiones tomadas.

## Objetivo

Reducir el cuello de botella de PRs gigantes (+100 archivos) generados por implementación "one-shot" de specs, dándole al agente autonomía para:

- Trocear el trabajo en slices pequeños y revisables (PRs apilados), una vez que un humano le asigna un spec (PR + label `valeria:runner-<usuario>`, ver §1 del diseño)
- Correr tests e2e (Playwright) y pedir review externo (GitHub Copilot) por sí mismo
- Reanudar automáticamente tras cortes de cuota, sin sesión continua ni intervención humana
- Escalar bloqueos reales a un humano (notificación por email) en vez de improvisar
- Correr en paralelo entre varios runners sin pisarse (claim por label, ver §9 del diseño)
