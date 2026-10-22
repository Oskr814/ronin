---
name: update-changelog
description: Agrega una release publicada de un repo de producto a su changelog, siguiendo el AGENTS.md y el README del repo del changelog, y la sube directo a main. Úsala cuando la corrida de ronin te pasa una release nueva para el changelog.
---

# Una release en el changelog

Un repo de producto acaba de publicar una release. Este checkout es el repo de su changelog, ya al día con su propio main: agrégale esta release. La corrida te da la release (nombre, tag y enlace), el repo de producto y el del changelog.

## Pasos

1. **Sigue el AGENTS.md y el README.md de este repo tal como están escritos.** Ya describen el flujo entero: cómo traer los datos reales de la release y de sus PRs, el esquema del frontmatter, el tono del texto, el manejo de las imágenes y la validación con `pnpm build`. No inventes tu propio formato ni te apartes de lo que dicen esos archivos.

2. **Los datos de la release:** `gh release view <tag> --repo <repo de producto> --json body,publishedAt,url` para el texto y la fecha, y después `gh pr view <n> --repo <repo de producto>` por cada PR que menciona, exactamente como lo describe la sección de flujo del AGENTS.md.

3. **Las capturas:** incluye las que muestra cada PR —las imágenes subidas a un PR se pueden usar tal cual, exactamente como lo describe la sección de imágenes del AGENTS.md—, salvo el «antes» de un hallazgo de exploración. Una imagen cuya URL termina en `/antes-<n>.<ext>` (por ejemplo `antes-1.png?raw=true`) muestra el problema como era, no lo que trae la release: déjala fuera.

4. **Cuando la entrada esté escrita y `pnpm build` pase,** commitea y sube directo a main (`git add -A && git commit && git push origin main`): el AGENTS.md de este repo dice que ese es su flujo normal, sin PR.

5. **Termina tu respuesta entera con exactamente una línea,** y nada después: `RONIN_STATUS: done`.
