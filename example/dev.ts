// `npm run example`: starts the demo API (port 5190) and the Vite dev server (port 5191)
// inside `firebase emulators:exec`, which provides the local Firestore emulator.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { createServer as createViteServer } from 'vite';
import { assertLocalEmulator, createDemoApp } from './server.ts';

const API_PORT = 5190;

const projectId = assertLocalEmulator();
const db = new Firestore({ projectId });
const app = createDemoApp(db);
await app.ensureAccounts();

const api = createServer(app.handler);
await new Promise<void>((resolve, reject) => {
    api.once('error', reject);
    api.listen(API_PORT, '127.0.0.1', () => resolve());
});

const vite = await createViteServer({ configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)) });
await vite.listen();
vite.printUrls();
console.log(`Demo API on http://127.0.0.1:${API_PORT} (project ${projectId}). Press Ctrl+C to stop.`);

let stopping = false;
const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await vite.close();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await db.terminate();
    process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
// If `emulators:exec` goes away without signalling us (e.g. it alone was stopped), stop too.
const parent = process.ppid;
setInterval(() => {
    if (process.ppid !== parent) void stop();
}, 1000).unref();
