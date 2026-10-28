// Reproducible build: bundles main, preload and renderers with esbuild into dist/.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist');
const prod = process.argv.includes('--prod');
fs.rmSync(out, { recursive: true, force: true });

const common = { bundle: true, sourcemap: prod ? false : 'linked', minify: prod, target: 'es2023', logLevel: 'warning', legalComments: 'none' };

await Promise.all([
  build({ ...common, entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(out, 'main/index.js'), platform: 'node', format: 'cjs', external: ['electron', 'koffi', '@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web', 'sharp'] }),
  build({ ...common, entryPoints: [path.join(root, 'src/preload/preload.ts')], outfile: path.join(out, 'preload/preload.js'), platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: { character: path.join(root, 'src/renderer/character/main.ts'), panel: path.join(root, 'src/renderer/panel/main.ts') }, outdir: path.join(out, 'renderer'), platform: 'browser', format: 'iife' }),
]);
for (const f of ['character.html', 'panel.html', 'panel.css']) {
  const src = path.join(root, 'src/renderer', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, 'renderer', f));
}
// real-footage cut-outs for the character (see assets/capri/SOURCES.md)
const capri = path.join(root, 'assets', 'capri');
if (fs.existsSync(capri)) fs.cpSync(capri, path.join(out, 'renderer', 'capri'), { recursive: true, filter: (f) => !f.endsWith('.md') });
console.log(`built ${prod ? 'production' : 'development'} bundle → dist/`);
