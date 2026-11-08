import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  decodeOriginal, sameOriginal, originalFromBlock, localPathFromBlock,
  collectGeneratedItems, readOriginal, Catalog, matchViewerImage,
} from '../src/core.js';

const CHUNK = 4 * 1024 * 1024;
const assetId = 'img_9a3e23f53061f35c0fdf1343df0a19b7';
const bytes = Buffer.from('original bytes');
function refFor(data = bytes, overrides = {}) {
  return { assetId, mediaType: 'image/png', bytes: data.length, width: 2, height: 3,
    name: 'original.png', sha256: createHash('sha256').update(data).digest('hex'), ...overrides };
}
const original = refFor();
const localPath = `C:\\Users\\Test\\.dsh\\dsh-codex-subscription\\images\\v1\\9a\\${assetId}\\original`;
function blockFor(ref = original, id = 'preview-1', path = localPath) {
  return { kind: 'tool-result', meta: { kind: 'codex-subscription-image', schemaVersion: 1, original: ref }, content: [
    { type: 'text', text: `Original PNG saved on the DSH host at: ${JSON.stringify(path)}. Read this file.` },
    { type: 'image', attachment: { attachmentId: id, name: 'preview.png', width: 1, height: 1 } },
  ] };
}
function itemFor(id = 'preview-1', ref = original, sessionId = 'session-1', path = localPath) {
  return { attachment: { attachmentId: id, name: 'preview.png' }, original: ref, sessionId, localPath: path };
}
function rpcFor(data = bytes, ref = refFor(data), mutate = value => value) {
  const calls = [];
  return { calls, async call(channel, endpoint, payload, signal) {
    calls.push({ channel, endpoint, payload, signal });
    const end = Math.min(data.length, payload.offset + CHUNK);
    return mutate({ ok: true, value: { ref, offset: payload.offset,
      encoded: data.subarray(payload.offset, end).toString('base64'), done: end === data.length } }, calls.length);
  } };
}

test('strict original decoder accepts bounded PNG metadata and strips extra fields', () => {
  assert.deepEqual(decodeOriginal({ ...original, ignored: true }), original);
  assert.notEqual(decodeOriginal(original), original);
  assert.equal(decodeOriginal({ ...original, bytes: 48 * 1024 * 1024 }).bytes, 48 * 1024 * 1024);
  for (const value of [null, [], false, { ...original, assetId: 'img_bad' },
    { ...original, assetId: assetId.toUpperCase() }, { ...original, mediaType: 'image/jpeg' },
    { ...original, bytes: 0 }, { ...original, bytes: 48 * 1024 * 1024 + 1 },
    { ...original, bytes: 1.5 }, { ...original, width: 0 }, { ...original, height: Infinity },
    { ...original, name: '../original.png' }, { ...original, name: 'x'.repeat(129) },
    { ...original, sha256: 'f'.repeat(63) }, { ...original, sha256: 'A'.repeat(64) }]) {
    assert.equal(decodeOriginal(value), undefined);
  }
});

test('original equality covers every metadata field and requires valid references', () => {
  assert.equal(sameOriginal(original, { ...original }), true);
  for (const [key, value] of Object.entries({ assetId: 'img_' + 'b'.repeat(32), bytes: 1,
    width: 1, height: 1, name: 'different.png', sha256: 'a'.repeat(64), mediaType: 'image/jpeg' })) {
    assert.equal(sameOriginal(original, { ...original, [key]: value }), false);
  }
  assert.equal(sameOriginal(undefined, undefined), false);
});

test('block original requires the exact presentation marker and schema', () => {
  assert.deepEqual(originalFromBlock(blockFor()), original);
  for (const meta of [undefined, [], { original }, { kind: 'other', schemaVersion: 1, original },
    { kind: 'codex-subscription-image', schemaVersion: 2, original }]) {
    assert.equal(originalFromBlock({ meta }), undefined);
  }
});

test('local host path hint is optional, exact, JSON escaped and asset scoped', () => {
  assert.equal(localPathFromBlock(blockFor(), original), localPath);
  const posix = `/home/user/.dsh/dsh-codex-subscription/images/v1/9a/${assetId}/original`;
  assert.equal(localPathFromBlock(blockFor(original, 'p', posix), original), posix);
  for (const path of [localPath.replace('v1\\9a', 'v1\\ff'),
    localPath.replace(assetId, 'img_' + 'b'.repeat(32)), localPath.replace('\\images', '\\..\\images'),
    localPath.replace('\\images', '\\.\\images'), localPath + '.png',
    localPath.replace('C:', 'relative'), '\\\\server\\share' + posix,
    '//server' + posix, 'C:\\Windows\\cmd.exe', localPath.replace('Test', 'Te\nst'),
    localPath.replace('Test', 'Te:st')]) {
    assert.equal(localPathFromBlock(blockFor(original, 'p', path), original), undefined, path);
  }
  assert.equal(localPathFromBlock({ content: blockFor().content }, original), undefined);
  assert.equal(localPathFromBlock(blockFor(), { ...original, width: 6 }), undefined);
  assert.equal(localPathFromBlock({ ...blockFor(), content: [{ type: 'text', text: 'Original PNG saved on the DSH host at: "bad\\q".' }] }, original), undefined);
});

test('collect records only first image per block and never manufactures originals', () => {
  const first = blockFor();
  first.content.push({ type: 'image', attachment: { attachmentId: 'not-first' } });
  const second = blockFor(original, 'preview-2');
  const props = { sessionId: 'session-1', node: { data: { blocks: [first, second, { content: first.content }] } } };
  const items = collectGeneratedItems(props);
  assert.deepEqual(items.map(item => item.attachment.attachmentId), ['preview-1', 'preview-2']);
  assert.equal(items[0].sessionId, 'session-1');
  assert.equal(items[0].localPath, localPath);
  assert.notEqual(items[0].attachment, first.content[1].attachment);
  assert.equal(collectGeneratedItems({ sessionId: 'session-1', block: first }).length, 1);
  assert.deepEqual(collectGeneratedItems({ block: first }), []);
  assert.deepEqual(collectGeneratedItems({ sessionId: 'session-1', block: { ...first, meta: undefined } }), []);
});

test('reader uses original RPC protocol, forwards signal and returns verified bytes', async () => {
  const rpc = rpcFor(), controller = new AbortController();
  const result = await readOriginal(rpc, 'session-1', original, { signal: controller.signal });
  assert.deepEqual(result, new Uint8Array(bytes));
  assert.deepEqual(rpc.calls[0], { channel: '/codex-subscription', endpoint: 'image/original/chunk',
    payload: { sessionId: 'session-1', assetId, offset: 0 }, signal: controller.signal });
});

test('reader handles full 4MiB chunks and exact final chunk without regex stack overflow', async () => {
  const data = Buffer.alloc(CHUNK + 5, 123), ref = refFor(data), rpc = rpcFor(data, ref);
  assert.deepEqual(await readOriginal(rpc, 'session-1', ref), new Uint8Array(data));
  assert.deepEqual(rpc.calls.map(call => call.payload.offset), [0, CHUNK]);
});

test('reader rejects wrong owner/error envelope, metadata, offset, done and byte counts', async () => {
  const mutations = [
    () => ({ ok: false, error: { message: 'not-found' } }),
    value => ({ ...value, ok: 1 }),
    value => ({ ...value, value: { ...value.value, ref: { ...original, width: 7 } } }),
    value => ({ ...value, value: { ...value.value, offset: 1 } }),
    value => ({ ...value, value: { ...value.value, done: false } }),
    value => ({ ...value, value: { ...value.value, done: 'true' } }),
    value => ({ ...value, value: { ...value.value, encoded: '' } }),
    value => ({ ...value, value: { ...value.value, encoded: bytes.subarray(1).toString('base64') } }),
    value => ({ ...value, value: { ...value.value, encoded: Buffer.concat([bytes, bytes]).toString('base64') } }),
  ];
  for (const mutate of mutations) await assert.rejects(readOriginal(rpcFor(bytes, original, mutate), 'session-1', original));
  const data = Buffer.alloc(CHUNK + 1, 1), ref = refFor(data);
  await assert.rejects(readOriginal(rpcFor(data, ref, value => ({ ...value, value: { ...value.value, done: true } })), 'session-1', ref));
});

test('reader rejects noncanonical base64 and whole-original digest mismatch', async () => {
  const one = Buffer.from('A'), ref = refFor(one);
  for (const encoded of ['QR==', 'QQ= ', 'QQ', '!!!!']) {
    await assert.rejects(readOriginal(rpcFor(one, ref, value => ({ ...value, value: { ...value.value, encoded } })), 'session-1', ref));
  }
  const wrong = refFor(bytes, { sha256: '0'.repeat(64) });
  await assert.rejects(readOriginal(rpcFor(bytes, wrong), 'session-1', wrong), /integrity/u);
});

test('reader cancellation and invalid requests never fall back to fetching preview', async () => {
  const controller = new AbortController(), rpc = rpcFor();
  controller.abort();
  await assert.rejects(readOriginal(rpc, 'session-1', original, { signal: controller.signal }));
  assert.equal(rpc.calls.length, 0);
  await assert.rejects(readOriginal(rpc, '', original));
  await assert.rejects(readOriginal(rpc, 'session-1', undefined));
  const mid = new AbortController();
  await assert.rejects(readOriginal(rpcFor(bytes, original, value => { mid.abort(); return value; }), 'session-1', original, { signal: mid.signal }));
});

test('catalog owner replacement, duplicate originals, session isolation and cleanup', () => {
  const catalog = new Catalog(), a = Symbol('a'), b = Symbol('b'), rpc = rpcFor();
  catalog.retain(a, [itemFor()], rpc);
  catalog.retain(b, [itemFor(), itemFor('preview-1', original, 'session-2')], rpc);
  assert.deepEqual(catalog.find('session-1', 'preview-1').target.original, original);
  assert.equal(catalog.find('session-1', 'preview-1').rpc, rpc);
  catalog.release(a);
  assert.ok(catalog.find('session-1', 'preview-1'));
  catalog.retain(b, [itemFor('preview-2')], rpc);
  assert.equal(catalog.find('session-1', 'preview-1'), undefined);
  assert.ok(catalog.find('session-1', 'preview-2'));
  catalog.clear();
  assert.equal(catalog.find('session-1', 'preview-2'), undefined);
});

test('catalog refuses conflicting originals and suppresses conflicting reveal hints', () => {
  const catalog = new Catalog(), a = {}, b = {}, rpc = rpcFor();
  catalog.retain(a, [itemFor()], rpc);
  catalog.retain(b, [itemFor('preview-1', { ...original, width: 7 })], rpc);
  assert.equal(catalog.find('session-1', 'preview-1'), undefined);
  catalog.retain(b, [itemFor('preview-1', original, 'session-1', localPath.replace('Test', 'Other'))], rpc);
  assert.equal(catalog.find('session-1', 'preview-1').target.localPath, undefined);
  const copy = catalog.find('session-1', 'preview-1');
  copy.target.original.width = 100;
  copy.target.attachment.attachmentId = 'poisoned';
  assert.equal(catalog.find('session-1', 'preview-1').target.original.width, 2);
});

test('viewer matches actual current URL and retry alias, never initial request.index', () => {
  const catalog = new Catalog(), rpc = rpcFor();
  catalog.retain({}, [itemFor('one'), itemFor('two')], rpc);
  const request = { source: 'codex-generated', scope: 'session-1', index: 0,
    items: [{ id: 'one', src: 'blob:one' }, { id: 'two', src: 'blob:two' }] };
  assert.equal(matchViewerImage(request, 'blob:two', catalog).target.attachment.attachmentId, 'two');
  const aliases = new Map([['two', new Set(['blob:retry-two'])]]);
  assert.equal(matchViewerImage(request, 'blob:retry-two', catalog, aliases).target.attachment.attachmentId, 'two');
  assert.equal(matchViewerImage({ ...request, source: 'codex-message' }, 'blob:two', catalog), undefined);
  assert.equal(matchViewerImage({ ...request, scope: 'session-2' }, 'blob:two', catalog), undefined);
  assert.equal(matchViewerImage(request, 'blob:unknown', catalog), undefined);
});

test('viewer ambiguity and malformed or unowned images fail closed', () => {
  const catalog = new Catalog(), rpc = rpcFor();
  catalog.retain({}, [itemFor('one'), itemFor('two')], rpc);
  const request = { source: 'codex-generated', scope: 'session-1', items: [
    { id: 'one', src: 'blob:shared' }, { id: 'two', src: 'blob:shared' },
  ] };
  assert.equal(matchViewerImage(request, 'blob:shared', catalog), undefined);
  assert.equal(matchViewerImage(request, 'blob:alias', catalog, new Map([
    ['one', new Set(['blob:alias'])], ['two', new Set(['blob:alias'])],
  ])), undefined);
  assert.equal(matchViewerImage(null, 'blob:shared', catalog), undefined);
  assert.equal(matchViewerImage({ ...request, items: [{ id: 'absent', src: 'blob:shared' }] }, 'blob:shared', catalog), undefined);
});
