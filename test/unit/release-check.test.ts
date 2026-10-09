// Release gate (scripts/check-release.mjs): refuses while the maintainer's decisions are placeholders, accepts once
// they are filled in. Runs against temporary copies, never against this checkout's own files.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = join(import.meta.dirname, '../../scripts/check-release.mjs');
const run = (root: string) => spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

const ready = {
    'LICENSE': 'MIT License\n\nCopyright (c) 2026 Example Maintainers\n',
    'SECURITY.md': '# Security policy\n\nReport privately to: security@example.invalid\n',
    'README.md': '# example\n\n> **Status: v0.1.0.**\n\n## Install\n\n```sh\nnpm install example\n```\n',
    'package.json': JSON.stringify({ name: 'example', version: '0.1.0', license: 'MIT', repository: { type: 'git', url: 'git+https://example.invalid/example.git' }, author: 'Example Maintainers' }),
};
type Files = Record<keyof typeof ready, string | null>;

function withFiles(files: Files, check: (result: ReturnType<typeof run>) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'release-check-'));
    try {
        for (const [name, content] of Object.entries(files)) if (content !== null) writeFileSync(join(root, name), content);
        check(run(root));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test('P01 release gate: filled-in decisions pass', () => {
    withFiles(ready, (result) => {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /check-release: OK/);
    });
});

test('P02 release gate: each placeholder or missing field is refused on its own', () => {
    const pkg = JSON.parse(ready['package.json']) as Record<string, unknown>;
    const cases: [string, Partial<Files>, RegExp][] = [
        ['copyright holder placeholder', { LICENSE: 'Copyright (c) 2026 <COPYRIGHT HOLDER: to be decided before publication>\n' }, /LICENSE/],
        ['security contact placeholder', { 'SECURITY.md': 'Report privately to: **<SECURITY CONTACT: to be provided by the maintainer before publication>**\n' }, /SECURITY\.md/],
        ['candidate status', { 'README.md': '> **Status: v0.1 local candidate.** Not published.\n' }, /README\.md/],
        ['not published yet', { 'README.md': 'The package is not published yet. From a checkout:\n' }, /README\.md/],
        ['private package', { 'package.json': JSON.stringify({ ...pkg, private: true }) }, /"private"/],
        ['no repository', { 'package.json': JSON.stringify({ ...pkg, repository: undefined }) }, /"repository"/],
        ['no author', { 'package.json': JSON.stringify({ ...pkg, author: undefined }) }, /"author"/],
        ['no license file', { LICENSE: null }, /LICENSE is missing/],
    ];
    for (const [label, change, expected] of cases) {
        withFiles({ ...ready, ...change }, (result) => {
            assert.equal(result.status, 1, `${label}: refused`);
            assert.match(result.stderr, expected, label);
        });
    }
});

test('P03 release gate: npm runs it before publishing, then rebuilds', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts.prepublishOnly, 'node scripts/check-release.mjs && npm run build');
});
