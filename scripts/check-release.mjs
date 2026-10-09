// Release gate, run by `npm publish` (prepublishOnly) and on demand (`npm run check:release`).
// Refuses while the maintainer's decisions are still placeholders: copyright holder, security contact,
// the "local candidate" status, package metadata. Usage: node scripts/check-release.mjs [package root]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const problems = [];
const read = (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null);

const license = read('LICENSE');
if (license === null) problems.push('LICENSE is missing');
else if (/<COPYRIGHT HOLDER|to be decided/i.test(license)) problems.push('LICENSE: the copyright holder is still a placeholder');

const security = read('SECURITY.md');
if (security === null) problems.push('SECURITY.md is missing');
else if (/<SECURITY CONTACT|to be provided/i.test(security)) problems.push('SECURITY.md: the security contact is still a placeholder');

const readme = read('README.md');
if (readme === null) problems.push('README.md is missing');
else {
    if (/local candidate|still to be decided/i.test(readme)) problems.push('README.md: the status still says "local candidate" or lists open decisions');
    if (/not published yet|尚未發布/.test(readme)) problems.push('README.md: still says the package is not published');
}

const pkgText = read('package.json');
if (pkgText === null) problems.push('package.json is missing');
else {
    const pkg = JSON.parse(pkgText);
    if (pkg.private === true) problems.push('package.json: "private" is true');
    if (typeof pkg.name !== 'string' || pkg.name.length === 0) problems.push('package.json: "name" is missing');
    if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) problems.push('package.json: "version" is not a release version');
    if (typeof pkg.license !== 'string' || pkg.license.length === 0) problems.push('package.json: "license" is missing');
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    if (typeof repository !== 'string' || repository.length === 0) problems.push('package.json: "repository" is missing');
    if (!pkg.author) problems.push('package.json: "author" is missing');
}

if (problems.length > 0) {
    console.error(`check-release: not ready to publish (${root})`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
}
console.log('check-release: OK');
