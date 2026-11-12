// Static contract check against an installed dsh-codex-subscription build.
// The adapter hooks slots, DOM class names and the chunk RPC, so a new
// upstream minor can silently stop matching. Run this before every release:
//
//   node scripts/check-codex-contract.mjs /path/to/node_modules/dsh-codex-subscription
//
// Without a path it reads the copy npm installed next to this package (if any).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(path, 'utf8');
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const target = process.argv[2] ?? join(root, 'node_modules', 'dsh-codex-subscription');
expect(existsSync(target), `Missing dsh-codex-subscription: pass its directory as the first argument (looked in ${target})`);

const upstream = JSON.parse(await read(join(target, 'package.json')));
const client = await read(join(target, 'lib', 'client.js'));
const viewer = await read(join(target, 'lib', 'client.image-viewer.js'));
const host = await read(join(target, 'lib', 'index.js'));

// 1. Slot registrations this plugin patches.
expect(client.includes('name: "conversation.chat.node"'), 'conversation.chat.node slot moved');
expect(client.includes('key: "codex-image-output"'), 'codex-image-output card key moved');
expect(client.includes('name: "tool.call.toolview"'), 'tool.call.toolview slot moved');
expect(client.includes('key: "codex_image_generate"'), 'codex_image_generate tool key moved');
expect(client.includes('name: "shell.overlay"'), 'shell.overlay slot moved');
expect(client.includes('id: "codex-subscription-image-viewer"'), 'viewer overlay id moved');

// 2. DOM surfaces the adapter looks for.
expect(client.includes('codexGeneratedImageFrame'), 'card frame class moved');
for (const token of ['dcsiv-root', 'dcsiv-surface', 'dcsiv-stage', 'dcsiv-image']) {
  expect(viewer.includes(token), `viewer class ${token} moved`);
}

// 3. Chunk RPC shape and limits, cross-checked against src/core.js.
expect(host.includes('image/original/chunk'), 'original chunk RPC removed');
expect(host.includes('/^img_[0-9a-f]{32}$/u'), 'asset id pattern changed');
const chunkBytes = /ORIGINAL_IMAGE_CHUNK_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/u.exec(host);
expect(chunkBytes !== null, 'chunk size constant renamed');
for (const field of ['ref: metadata.image', 'offset,', 'encoded:', 'done: offset + length === stat.size']) {
  expect(host.includes(field), `chunk payload field changed: ${field}`);
}

const core = await read(join(root, 'src', 'core.js'));
const localChunk = /const CHUNK_BYTES = (\d+) \* 1024 \* 1024;/u.exec(core);
const localAsset = /const ASSET_ID = (\/\^img_\[0-9a-f\]\{32\}\$\/u);/u.exec(core);
expect(localChunk !== null && localAsset !== null, 'src/core.js constants renamed');
expect(Number(chunkBytes[1]) === Number(localChunk[1]), `chunk size drifted: upstream ${chunkBytes[1]} MiB vs local ${localChunk[1]} MiB`);
expect(host.includes(`/^img_[0-9a-f]{32}$/u`) && localAsset[1] === '/^img_[0-9a-f]{32}$/u', 'asset id pattern drifted');

console.log(`dsh-codex-subscription ${upstream.version}: slot keys, viewer classes and chunk RPC match this adapter`);
