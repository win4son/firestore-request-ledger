// Post-build checks on the package as consumers receive it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// 1. The exports map resolves (package self-reference) and exposes the documented API.
const server = await import('firestore-request-ledger/server');
const client = await import('firestore-request-ledger/client');
const wire = await import('firestore-request-ledger/wire');
for (const name of ['execute', 'lookup', 'reject', 'errorReply', 'requestDocId', 'fingerprintRequest', 'RequestRejection', 'LedgerError']) {
    assert.equal(typeof server[name], 'function', `server export ${name}`);
}
for (const name of ['createRequestTracker', 'NotSentError', 'randomRequestId', 'isTerminalFor', 'settledReplyFor']) {
    assert.equal(typeof client[name], 'function', `client export ${name}`);
}
assert.equal(typeof wire.settledReplyFor, 'function');

// 2. The browser entry must not pull in Node built-ins.
const clientDir = new URL('../dist/client/', import.meta.url);
const sharedDir = new URL('../dist/shared/', import.meta.url);
for (const dir of [clientDir, sharedDir]) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
        const text = readFileSync(new URL(file, dir), 'utf8');
        assert.ok(!/from ['"]node:/.test(text), `${file} imports a Node built-in`);
    }
}

// 3. A strict consumer type-checks against the emitted declarations.
run(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'test/fixtures/tsconfig.consumer.json']);

// 4. Only the intended files would be packed.
const packed = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']))[0].files.map((f) => f.path).sort();
const unexpected = packed.filter((p) => !(p.startsWith('dist/') || ['LICENSE', 'README.md', 'package.json'].includes(p)));
assert.deepEqual(unexpected, [], 'unexpected files in the package');
assert.ok(packed.includes('dist/server/index.js') && packed.includes('dist/client/index.d.ts'));

console.log(`check-dist: OK (${packed.length} files would be packed)`);
