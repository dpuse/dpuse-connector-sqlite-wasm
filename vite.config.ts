// ── External Dependencies & Registrations
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import path from 'node:path';
import type { Plugin } from 'vite';
import Sonda from 'sonda/vite';
import { fileURLToPath, URL } from 'node:url';

// ── DPUse Framework
import { recordShippedPackages } from '@dpuse/dpuse-development/vite';

// ── Data
import config from './config.json' with { type: 'json' };

// ── Plugins ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// Ships SQLite's '.wasm' file beside the connector's script, not inlined, so it is smaller to download and compiles
// while it downloads. In library mode Vite inlines every file that SQLite names with 'new URL(…, import.meta.url)',
// including two workers the connector never starts, so those references are hidden from Vite. The connector finds the
// '.wasm' file itself through 'locateFile'.
function shipSqliteWasm(): Plugin {
    const wasmPath = createRequire(import.meta.url).resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm');
    return {
        enforce: 'pre',
        name: 'ship-sqlite-wasm',
        transform(code, id) {
            if (!id.includes('@sqlite.org/sqlite-wasm/dist/index.mjs')) return;
            return { code: code.replaceAll(/new URL\(("[^"]+"), import\.meta\.url\)/gu, 'new URL($1, globalThis.location.href)'), map: null }; // Same lines, so the map stays right.
        },
        writeBundle(options) {
            copyFileSync(wasmPath, path.join(options.dir ?? 'dist', 'sqlite3.wasm'));
        }
    };
}

// ── Vite Configuration ───────────────────────────────────────────────────────────────────────────────────────────────

const viteConfig = defineConfig({
    build: {
        lib: {
            entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
            fileName: (format) => `${config.id}.${format}.js`,
            formats: ['es']
        },
        rolldownOptions: {
            plugins: [Sonda({ filename: 'index', format: 'json', brotli: false, gzip: true, open: false, outputDir: './bundle-analysis-reports/sonda' })]
        },
        sourcemap: 'hidden',
        target: 'esnext'
    },
    // Tests and config files sit in the tsconfig so they get type-checked, but their declarations must not reach the
    // published package. 'entryRoot' keeps the types under 'dist/types/src', where package.json points.
    // 'recordShippedPackages' writes the record of what the build ships, which 'npm run document' lists licences from.
    plugins: [shipSqliteWasm(), dts({ entryRoot: '.', exclude: ['tests/**', '*.config.*'], outDirs: 'dist/types' }), recordShippedPackages()],
    resolve: {
        alias: {
            '~': fileURLToPath(new URL('./', import.meta.url)),
            '@': fileURLToPath(new URL('src', import.meta.url))
        }
    }
});

export default viteConfig;
