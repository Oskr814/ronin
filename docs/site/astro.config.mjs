import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

// Published on GitHub Pages under the repo's name, so every internal link
// starts with /ronin/ — the links validator fails the build on one that doesn't.
export default defineConfig({
  site: 'https://oskr814.github.io',
  base: '/ronin',
  integrations: [
    starlight({
      title: 'ronin',
      description: 'Agentes autónomos que trabajan tus issues y PRs en GitHub.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      locales: { root: { label: 'Español', lang: 'es' } },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Oskr814/ronin' }],
      editLink: { baseUrl: 'https://github.com/Oskr814/ronin/edit/main/docs/site/' },
      customCss: ['./src/styles/ronin.css'],
      plugins: [starlightLinksValidator()],
      sidebar: [
        { label: 'Empezar', items: ['empezar/que-es', 'empezar/primer-issue', 'empezar/el-tablero'] },
        {
          label: 'Guías',
          items: [
            'guias/darle-trabajo',
            'guias/decidir-un-pr',
            'guias/revisar-un-pr',
            'guias/probar-con-preview',
            'guias/pedidos-del-portal',
            'guias/explorar-una-app',
            'guias/reuniones',
            'guias/desplegar',
            'guias/metricas',
          ],
        },
        {
          label: 'Referencia',
          items: [
            'referencia/comandos',
            'referencia/acciones',
            'referencia/atajos',
            'referencia/bloqueos',
            'referencia/labels',
            'referencia/repos-json',
            'referencia/app-json',
            'referencia/entorno',
          ],
        },
        {
          label: 'Operar un runner',
          collapsed: true,
          items: [
            'operar/docker',
            'operar/instalacion',
            'operar/respaldos',
            'operar/servidor',
            'operar/tablero',
            'operar/portal',
            'operar/ajustes',
            'operar/base-de-datos',
            'operar/linear',
            'operar/changelog',
            'operar/problemas',
          ],
        },
        { label: 'Cómo funciona', collapsed: true, items: ['como-funciona/arquitectura', 'como-funciona/tick', 'como-funciona/slices', 'como-funciona/review'] },
        { label: 'Contribuir', collapsed: true, items: ['contribuir/documentacion'] },
      ],
    }),
  ],
});
