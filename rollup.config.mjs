import { rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';

import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { defineConfig } from 'rollup';

export default defineConfig((args) => ({
  input: './src/extension.ts',
  output: {
    dir: './dist',
    format: 'commonjs',
    indent: '\t',
    sourcemap: true,
    entryFileNames: '[name].js',
    chunkFileNames: '[name].js',
    manualChunks(id) {
      if (id.includes('node_modules')) {
        return 'vendor';
      }
    },
    plugins: [
      !args.watch && dist(),
    ],
  },
  external: [...builtinModules, 'vscode'],
  plugins: [
    resolve(),
    commonjs(),
    typescript({
      compilerOptions: {
        outDir: './dist',
        module: 'esnext',
        moduleResolution: 'bundler',
      },
    }),
  ],
}));

/**
 * @return {import('rollup').OutputPlugin}
 */
function dist() {
  const minifier = terser();

  return {
    name: 'vscode-extension-dist',
    async renderChunk(code, chunk, options, meta) {
      if (chunk.name === 'vendor') {
        return await minifier.renderChunk(code, chunk, options, meta);
      }
    },
    async writeBundle() {
      await rm('./dist/vendor.js.map', { force: true });
    },
  };
}
