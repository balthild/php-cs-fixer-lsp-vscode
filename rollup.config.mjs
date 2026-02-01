import { builtinModules } from 'node:module';

import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { defineConfig } from 'rollup';

export default defineConfig((args) => ({
  input: './src/extension.ts',
  output: {
    dir: './dist',
    format: 'commonjs',
    sourcemap: args.watch,
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
        sourceMap: args.watch,
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
      } else {
        const child = spawn('dprint', ['fmt', '--stdin', 'js']);
        child.stdin.end(code);

        let formatted = '';
        for await (const chunk of child.stdout) {
          formatted += chunk;
        }

        return formatted;
      }
    },
  };
}
