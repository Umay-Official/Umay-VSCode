// Bundles the extension into dist/extension.js (one file, no node_modules in the package) and copies the
// webview's libraries into media/vendor. --production minifies; --watch rebuilds on change.
import { context, build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

mkdirSync('media/vendor', { recursive: true });
for (const [from, to] of [
  ['node_modules/marked/lib/marked.umd.js', 'media/vendor/marked.umd.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'media/vendor/purify.min.js'],
  ['node_modules/@vscode/codicons/dist/codicon.css', 'media/vendor/codicon.css'],
  ['node_modules/@vscode/codicons/dist/codicon.ttf', 'media/vendor/codicon.ttf'],
]) copyFileSync(from, to);

const options = {
  entryPoints: ['src/extension.js'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  // VS Code 1.85 runs extensions on Node 18.
  target: 'node18',
  external: ['vscode'],
  minify: production,
  sourcemap: production ? false : 'linked',
  legalComments: 'inline',
  logLevel: 'info',
};

if (watch) await (await context(options)).watch();
else await build(options);
