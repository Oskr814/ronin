// After `tsc` (pnpm build): the @apps/… @domains/… @platform/… aliases
// (#310) become relative paths in dist/. tsc resolves them through `paths` in
// tsconfig.json but leaves them as written, and node doesn't know them, so
// without this the server wouldn't start from dist/. An alias whose file
// isn't in dist/ stops the build.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const dist = join(import.meta.dirname, '..', 'dist');
const alias = /((?:\bfrom|\bimport|\bimport\()\s*)(['"])@(apps|domains|platform|ui)\/([^'"]+)\2/g;

const files = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.js') && !f.startsWith(`public${sep}`));

const missing: string[] = [];
for (const file of files) {
  const path = join(dist, file);
  const text = readFileSync(path, 'utf8');
  const next = text.replace(alias, (_all, pre: string, q: string, root: string, rest: string) => {
    const target = join(dist, root, rest);
    if (!existsSync(target)) missing.push(`${file}: @${root}/${rest}`);
    const spec = relative(dirname(path), target).split(sep).join('/');
    return `${pre}${q}${spec.startsWith('.') ? spec : `./${spec}`}${q}`;
  });
  if (next !== text) writeFileSync(path, next);
}

if (missing.length) {
  console.error(`dist-aliases: imports sin su archivo en dist/:\n${missing.join('\n')}`);
  process.exit(1);
}
