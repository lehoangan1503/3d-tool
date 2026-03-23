import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs/promises';
import fssync from 'node:fs';

const repoRoot = process.cwd();
const outDir = path.join(repoRoot, 'dist', 'shopify');

await fs.mkdir(outDir, { recursive: true });

function resolveWithExtensions(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.js'),
    path.join(basePath, 'index.mjs'),
  ];

  for (const c of candidates) {
    if (fssync.existsSync(c)) return c;
  }

  return basePath;
}

const aliasAtPlugin = {
  name: 'alias-at',
  setup(esbuild) {
    esbuild.onResolve({ filter: /^@\// }, (args) => {
      const basePath = path.join(repoRoot, 'src', args.path.slice(2));
      return { path: resolveWithExtensions(basePath) };
    });
  },
};

await build({
  entryPoints: [path.join(repoRoot, 'src', 'shopify', 'cue-3d-bundle.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outfile: path.join(outDir, 'cue-3d-bundle.js'),
  sourcemap: true,
  minify: false,
  plugins: [aliasAtPlugin],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

console.log(`[build-shopify] Output: ${path.relative(repoRoot, path.join(outDir, 'cue-3d-bundle.js'))}`);
