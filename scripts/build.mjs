import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

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
  build({
    ...common,
    entryPoints: ['src/preload/ui.ts'],
    outfile: 'dist/preload/ui.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
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
cpSync('src/pages', 'dist/pages', { recursive: true });
