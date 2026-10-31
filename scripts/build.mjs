import { build } from 'esbuild';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2023' };

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  // Sandboxed preloads must be a single CommonJS file that only requires "electron".
  ...['ui', 'tab'].map((name) =>
    build({
      ...common,
      entryPoints: [`src/preload/${name}.ts`],
      outfile: `dist/preload/${name}.js`,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    }),
  ),
  // Internal pages: each src/pages/<name>/page.ts becomes dist/pages/<name>/page.js.
  ...readdirSync('src/pages')
    .filter((name) => existsSync(`src/pages/${name}/page.ts`))
    .map((name) =>
      build({
        ...common,
        entryPoints: [`src/pages/${name}/page.ts`],
        outfile: `dist/pages/${name}/page.js`,
        platform: 'browser',
        format: 'iife',
      }),
    ),
  build({
    ...common,
    entryPoints: ['src/renderer/app.ts'],
    outfile: 'dist/renderer/app.js',
    platform: 'browser',
    format: 'iife',
  }),
]);

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
cpSync('src/pages', 'dist/pages', {
  recursive: true,
  filter: (src) => !src.endsWith('.ts') && !src.includes('/_shared'),
});
// Every internal page gets the shared stylesheet at min://<page>/common.css.
for (const name of readdirSync('src/pages')) {
  if (!name.startsWith('_')) cpSync('src/pages/_shared/common.css', `dist/pages/${name}/common.css`);
}
