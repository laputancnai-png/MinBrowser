import { build } from 'esbuild';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

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
  ...['ui', 'tab', 'popup', 'shield', 'translator'].map((name) =>
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
  build({
    ...common,
    entryPoints: ['src/renderer/split-shield.ts'],
    outfile: 'dist/renderer/split-shield.js',
    platform: 'browser',
    format: 'iife',
  }),
  // The translation engine page and its worker.
  ...['page', 'worker'].map((name) =>
    build({
      ...common,
      entryPoints: [`src/translator/${name}.ts`],
      outfile: `dist/translator/${name}.js`,
      platform: 'browser',
      format: 'iife',
    }),
  ),
  build({
    ...common,
    entryPoints: ['src/renderer/bookmark-popup.ts'],
    outfile: 'dist/renderer/bookmark-popup.js',
    platform: 'browser',
    format: 'iife',
  }),
]);

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/translator/index.html', 'dist/translator/index.html');
// Mozilla's engine loader, unchanged (MPL-2.0, see vendor/bergamot/README.md).
cpSync('vendor/bergamot/bergamot-translator.js', 'dist/translator/bergamot-translator.js');
cpSync('vendor/bergamot/LICENSE', 'dist/translator/LICENSE-bergamot.txt');
// The engine and English → Chinese model (read by the main process, checked against pinned hashes).
cpSync('vendor/bergamot/models', 'dist/translation-models', { recursive: true });
cpSync('vendor/bergamot/LICENSE', 'dist/translation-models/LICENSE.txt');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
cpSync('src/renderer/bookmark-popup.html', 'dist/renderer/bookmark-popup.html');
cpSync('src/renderer/bookmark-popup.css', 'dist/renderer/bookmark-popup.css');
cpSync('src/renderer/split-shield.html', 'dist/renderer/split-shield.html');
cpSync('src/renderer/split-shield.css', 'dist/renderer/split-shield.css');
// The app icon: window/dock icon at runtime, and the logo on the lock, setup and new tab screens.
cpSync('src/assets', 'dist/assets', { recursive: true });
cpSync('src/assets/icon.png', 'dist/renderer/icon.png');
cpSync('src/pages', 'dist/pages', {
  recursive: true,
  filter: (src) => !src.endsWith('.ts') && !src.includes('/_shared'),
});
// Every internal page gets the shared stylesheet at min://<page>/common.css.
for (const name of readdirSync('src/pages')) {
  if (!name.startsWith('_')) cpSync('src/pages/_shared/common.css', `dist/pages/${name}/common.css`);
}
cpSync('src/assets/icon.png', 'dist/pages/newtab/icon.png');
// Stamp the version into the new tab page.
{
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const page = 'dist/pages/newtab/index.html';
  writeFileSync(page, readFileSync(page, 'utf8').replace('{{VERSION}}', `v${version.split('.').slice(0, 2).join('.')}`));
}
