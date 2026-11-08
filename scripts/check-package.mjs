import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(resolve(root, name), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const expect = (condition, message) => { if (!condition) throw new Error(message); };
expect(pkg.name === 'dsh-image-context-menu' && pkg.version === '0.1.0', 'Unexpected package identity');
expect(pkg.private !== true && pkg.license === 'MIT', 'Publication manifest is not public MIT');
expect(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'Missing installable bundle patch');
expect(pkg.exports?.['./client'] === './lib/client.js', 'Missing built browser export');
expect(pkg.engines?.dsh === '0.2.2-rc.1' && pkg.peerDependencies?.['dsh-codex-subscription'] === '3.2.6', 'Compatibility must remain explicitly tested');
for (const name of ['preinstall','install','postinstall','prepare','prepack']) expect(!pkg.scripts?.[name], 'Install/pack must not execute build hooks');
expect(!pkg.dependencies, 'No host, React or upstream implementation may be bundled as a dependency');
const files = ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh.md', 'PUBLISHING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md'];
for (const file of await readdir(resolve(root, 'locale'))) if (file.endsWith('.json')) files.push('locale/' + file);
const privateData = /[A-Z]:\\(?:Users|Project)\\|(?:ghp_|github_pat_)[A-Za-z0-9_]{12,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/u;
for (const file of files) {
  const text = await read(file);
  expect(text.length > 0, 'Empty release file: ' + file);
  expect(!privateData.test(text), 'Possible private/local data in ' + file);
}
for (const code of ['lib/client.js', 'lib/index.js']) {
  const text = await read(code);
  expect(!/\beval\s*\(|new Function\s*\(/u.test(text), 'Dynamic source execution is not allowed in ' + code);
}
const browser = await read('lib/client.js');
expect(browser.includes(`id: "${pkg.name}"`), 'Lazy-factory id mismatch');
expect(!/^import\s|^export\s/m.test(browser), 'Browser artifact must be a self-registering lazy factory');
expect(browser.includes("require('react')") && browser.includes("require('react/jsx-runtime')"), 'Use host React, not another copy');
const zh = JSON.parse(await read('locale/zh.json')), en = JSON.parse(await read('locale/en.json'));
expect(zh.meta?.title && zh.meta?.description && en.meta?.title && en.meta?.description, 'Missing bilingual market metadata');
expect((await read('cordis.patch.yml')).includes('name: ' + pkg.name), 'Bundle patch package mismatch');
await mkdir(resolve(root, 'dist'), { recursive: true });
console.log('Publication allowlist:', files.join(', '));
console.log('Browser SHA-256:', createHash('sha256').update(browser).digest('hex'));
console.log('Package checks passed; no local images, profile data or credential files are on the release allowlist.');
