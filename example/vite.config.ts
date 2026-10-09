import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Ports are chosen to stay clear of common Firebase emulator defaults.
export default defineConfig({
    root: exampleRoot,
    oxc: { jsx: { runtime: 'automatic' } },
    server: {
        host: '127.0.0.1',
        port: 5191,
        strictPort: true,
        fs: { allow: [repoRoot] },
        proxy: { '/api': 'http://127.0.0.1:5190' },
    },
    preview: { host: '127.0.0.1', port: 5191, strictPort: true },
    build: { outDir: 'dist', emptyOutDir: true },
});
