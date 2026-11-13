// These are isolated adapter/unit tests, not browser or real React integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { Catalog } from '../src/core.js';

const MENU = 'dsh-image-context-menu.original';
const payload = Buffer.from('verified original');
const original = { assetId: 'img_' + 'a'.repeat(32), mediaType: 'image/png', bytes: payload.length,
  width: 2, height: 3, name: 'original.png', sha256: createHash('sha256').update(payload).digest('hex') };
const specs = [
  { name: 'conversation.chat.node', key: 'codex-image-output', component: 'CodexImageOutput', mode: 'card' },
  { name: 'tool.call.toolview', key: 'codex_image_generate', component: 'CodexImageToolRow', mode: 'card' },
  { name: 'shell.overlay', id: 'codex-subscription-image-viewer', component: 'DeferredImageViewer', mode: 'viewer' },
];
const named = name => Object.defineProperty(function OriginalComponent() {}, 'name', { value: name });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

function hookStub() {
  let active;
  const hook = initialize => {
    assert.ok(active, 'Hook must run inside explicit test render');
    const index = active.cursor++;
    return [active, index, active.slots[index] ??= initialize()];
  };
  const React = {
    useRef(value) { return hook(() => ({ current: value }))[2]; },
    useMemo(factory, deps) {
      const [runner, index, saved] = hook(() => ({ initialized: false }));
      if (!saved.initialized || !sameDeps(saved.deps, deps)) runner.slots[index] = { initialized: true, deps, value: factory() };
      return runner.slots[index].value;
    },
    useCallback(callback, deps) { return React.useMemo(() => callback, deps); },
    useSyncExternalStore(_subscribe, getSnapshot) { hook(() => ({})); return getSnapshot(); },
    useLayoutEffect(effect, deps) {
      const [runner, index, saved] = hook(() => ({ initialized: false }));
      if (!saved.initialized || !sameDeps(saved.deps, deps)) runner.pending.push(() => {
        saved.cleanup?.();
        runner.slots[index] = { initialized: true, deps, cleanup: effect() };
      });
    },
    useEffect(effect, deps) { React.useLayoutEffect(effect, deps); },
  };
  return { React, runner(Component) {
    const runner = { slots: [], cursor: 0, pending: [], render(props, domRoot) {
      active = runner; runner.cursor = 0;
      let result;
      try { result = Component(props); } finally { active = undefined; }
      if (result?.props?.ref && domRoot) result.props.ref.current = domRoot;
      for (const commit of runner.pending.splice(0)) commit();
      return result;
    }, unmount() { for (const slot of runner.slots) slot?.cleanup?.(); runner.slots = []; } };
    return runner;
  } };
}

class ElementStub {
  constructor(tag = 'div', classes = '', children = []) {
    this.tag = tag; this.classes = new Set(classes.split(' ').filter(Boolean)); this.children = children;
    for (const child of children) child.parent = this;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const [tag, ...classes] = part.trim().split('.');
      return (!tag || tag === this.tag) && classes.every(value => this.classes.has(value));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  querySelector(selector) {
    for (const child of this.children) { if (child.matches(selector)) return child; const nested = child.querySelector(selector); if (nested) return nested; }
    return undefined;
  }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) { if (child.matches(selector)) found.push(child); found.push(...child.querySelectorAll(selector)); }
    return found;
  }
  getBoundingClientRect() { return { left: 10, bottom: 20 }; }
}
function eventHub() {
  const listeners = [];
  return {
    addEventListener(type, fn, capture = false) { listeners.push({ type, fn, capture: capture === true }); },
    removeEventListener(type, fn, capture = false) { const i = listeners.findIndex(value => value.type === type && value.fn === fn && value.capture === (capture === true)); if (i >= 0) listeners.splice(i, 1); },
    emit(type, event, capture = false) { for (const listener of [...listeners]) if (listener.type === type && listener.capture === capture) { listener.fn(event); if (event.immediateStopped) break; } },
    count() { return listeners.length; },
  };
}
function eventFor(target, options = {}) {
  return { type: 'contextmenu', target, clientX: 30, clientY: 40, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediateStopped = true; }, ...options };
}
function snapshotStore(initial = null) {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of [...listeners]) fn(); } };
}

function loadAdapter() {
  const hooks = hookStub(), window = eventHub(), document = eventHub();
  document.documentElement = { dataset: { platform: 'win32' } };
  let definition;
  window.__ModuleLoader__ = { load(value) { definition = value; } };
  const context = { window, document, Element: ElementStub, Blob, File, URL, AbortController, AbortSignal,
    crypto: webcrypto, atob, btoa, queueMicrotask, setTimeout, clearTimeout, console };
  let text = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const marker = 'return { apply, inject };';
  assert.equal(text.split(marker).length, 2, 'Built client exposes one known module return seam');
  text = text.replace(marker, 'return { apply, inject, __test: { installWrapper, viewerFacade, cardComponent, viewerComponent, galleryComponent, matchUserImage, attachFiles, withSession, installViewerKeyGuard, installMenus, readUserImage } };');
  vm.runInNewContext(text, context, { filename: 'client.adapter-test.in-memory.js' });
  assert.equal(definition.id, 'dsh-image-context-menu');
  const exports = definition.factory(id => {
    if (id === 'react') return hooks.React;
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
    throw new Error(`Unexpected module dependency: ${id}`);
  });
  return { ...exports.__test, exports, hooks, window, document };
}

function slotStub() {
  const declared = new Set(specs.map(spec => spec.name));
  const entries = new Map(), subscribers = new Map(), waiting = new Set();
  let writes = 0;
  const pending = new Set();
  const notify = name => {
    if (pending.has(name)) return;
    pending.add(name);
    queueMicrotask(() => { pending.delete(name); for (const fn of [...(subscribers.get(name) ?? [])]) fn(); });
  };
  const slots = {
    entries: name => entries.get(name) ?? [],
    subscribe(name, fn) { let listeners = subscribers.get(name); if (!listeners) subscribers.set(name, listeners = new Set()); listeners.add(fn); return () => listeners.delete(fn); },
    inject(name, callback) {
      const waiter = { name, callback, dispose: declared.has(name) ? callback() : undefined };
      waiting.add(waiter);
      return () => { waiting.delete(waiter); waiter.dispose?.(); waiter.dispose = undefined; };
    },
    register(options, component) {
      assert.ok(declared.has(options.name));
      assert.ok(++writes < 100, 'Own registration notifications must not cause an infinite registration loop');
      const entry = { options, component, inject: options.inject, locale: options.locale, children: options.children, store: options.store };
      entries.set(options.name, [...slots.entries(options.name), entry]); notify(options.name);
      let disposed = false;
      return () => { if (disposed) return; disposed = true; entries.set(options.name, slots.entries(options.name).filter(value => value !== entry)); notify(options.name); };
    },
    collapse(name) { declared.delete(name); for (const waiter of waiting) if (waiter.name === name) { waiter.dispose?.(); waiter.dispose = undefined; } },
    declare(name) { declared.add(name); for (const waiter of waiting) if (waiter.name === name && !waiter.dispose) waiter.dispose = waiter.callback(); },
    writes: () => writes,
  };
  return slots;
}
function runtimeStub() {
  const lifetime = new AbortController();
  const generation = snapshotStore(0);
  const runtime = { lifetime, catalog: new Catalog(), viewers: new Set(), viewerOpen: false,
    rpc: { call: async () => ({ ok: true, value: { ref: original, offset: 0, done: true, encoded: payload.toString('base64') } }) },
    getGeneration: generation.getSnapshot, subscribeGeneration: generation.subscribe, operationSignal: () => lifetime.signal,
    shown: [], show(target, point) { this.shown.push({ target, point }); }, closeViewers() { for (const service of this.viewers) service.close(); } };
  return { runtime, generation };
}
function blockFor(id = 'preview-1', ref = original) {
  return { kind: 'tool-result', meta: { kind: 'codex-subscription-image', schemaVersion: 1, original: ref },
    content: [{ type: 'image', attachment: { attachmentId: id, name: 'preview.png' } }] };
}
function recordFor(id = 'preview-1', ref = original) {
  return { attachment: { attachmentId: id }, original: ref, sessionId: 'session-1' };
}

test('built module materializes without importing or patching the upstream plugin', () => {
  const adapter = loadAdapter();
  assert.equal(typeof adapter.exports.apply, 'function');
  assert.ok(Array.from(adapter.exports.inject).includes('slots'));
});

test('all three slot targets preserve exact original inject/locale and reconcile without loops', async () => {
  const adapter = loadAdapter(), slots = slotStub(), disposers = [];
  const originals = specs.map(spec => {
    const inject = () => ({ hooks: { sample: snapshotStore() }, opaquePrivateService: {} });
    const component = named(spec.component);
    slots.register({ name: spec.name, ...(spec.key ? { key: spec.key } : { id: spec.id }), inject, locale: 'codex-test' }, component);
    return { component, inject };
  });
  for (const spec of specs) disposers.push(adapter.installWrapper({ slots }, spec, runtimeStub().runtime));
  await flush();
  assert.equal(slots.writes(), 6);
  for (let i = 0; i < specs.length; i++) {
    const rows = slots.entries(specs[i].name);
    assert.equal(rows.length, 2);
    const wrapper = rows.find(entry => entry.component !== originals[i].component);
    assert.equal(wrapper.inject, originals[i].inject, 'Renderer, not wrapper, must execute/bind original inject');
    assert.equal(wrapper.locale, 'codex-test');
    assert.equal(wrapper.options.priority, -20);
    assert.equal(specs[i].key ? wrapper.options.key : wrapper.options.id, specs[i].key ?? specs[i].id);
  }
  for (const dispose of disposers) dispose();
  await flush();
  for (let i = 0; i < specs.length; i++) assert.equal(slots.entries(specs[i].name)[0].component, originals[i].component);
  assert.equal(slots.writes(), 6, 'Disable only removes companions, never rewrites originals');
});

test('slot source replacement, source disappearance, late source and declaration remount are handled', async () => {
  const adapter = loadAdapter(), slots = slotStub(), spec = specs[0], ctx = { slots };
  const stop = adapter.installWrapper(ctx, spec, runtimeStub().runtime);
  assert.equal(slots.entries(spec.name).length, 0);
  const first = named(spec.component), removeFirst = slots.register({ name: spec.name, key: spec.key }, first);
  await flush();
  const firstWrapper = slots.entries(spec.name).find(entry => entry.component !== first).component;
  removeFirst(); await flush();
  assert.equal(slots.entries(spec.name).length, 0);
  const replacement = named(spec.component);
  slots.register({ name: spec.name, key: spec.key }, replacement); await flush();
  assert.equal(slots.entries(spec.name).length, 2);
  assert.notEqual(slots.entries(spec.name).find(entry => entry.component !== replacement).component, firstWrapper);
  slots.collapse(spec.name); await flush();
  assert.equal(slots.entries(spec.name).length, 1);
  slots.declare(spec.name); await flush();
  assert.equal(slots.entries(spec.name).length, 2);
  stop(); await flush();
  assert.equal(slots.entries(spec.name).length, 1);
});

test('ambiguous or non-leaf slot sources are declined rather than recursively wrapped', async () => {
  for (const additions of [[{ children: { child: {} } }], [{ store: {} }], [{}, {}]]) {
    const adapter = loadAdapter(), slots = slotStub(), spec = specs[1];
    for (const extra of additions) slots.register({ name: spec.name, key: spec.key, ...extra }, named(spec.component));
    const stop = adapter.installWrapper({ slots }, spec, runtimeStub().runtime); await flush();
    assert.equal(slots.entries(spec.name).length, additions.length);
    stop();
  }
});

test('viewer facade preserves private-field receivers, immutable snapshots and observed retry aliases', async () => {
  const adapter = loadAdapter(), aliases = new Map();
  const download = { onInvoke() {} }, actions = [{ id: 'edit', onInvoke() {} }];
  class PrivateViewer {
    #request = { source: 'codex-generated', scope: 'session-1', revision: 1, index: 0,
      items: [{ id: 'preview-1', src: 'blob:preview', download, actions, reload: async suffix => 'blob:retry-' + suffix }] };
    #closed = 0;
    getSnapshot() { return this.#request; }
    subscribe() { assert.ok(this.#request); return () => {}; }
    close() { return ++this.#closed; }
    invoke(value) { return this.#request.scope + ':' + value; }
    set(value) { this.#request = value; }
  }
  const originalService = new PrivateViewer(), facade = adapter.viewerFacade(originalService, aliases);
  const raw = originalService.getSnapshot(), wrapped = facade.getSnapshot();
  assert.ok(Object.isFrozen(facade));
  assert.notEqual(wrapped, raw);
  assert.equal(facade.getSnapshot(), wrapped, 'uSES must see identical object until real snapshot changes');
  assert.equal(wrapped.items[0].download, download);
  assert.equal(wrapped.items[0].actions, actions);
  assert.equal(raw.items[0].src, 'blob:preview');
  assert.equal(await wrapped.items[0].reload('new'), 'blob:retry-new');
  assert.ok(aliases.get('preview-1').has('blob:retry-new'));
  assert.equal(facade.invoke('edit'), 'session-1:edit');
  assert.equal(facade.close(), 1);
  assert.equal(facade.close(), 2);
  facade.subscribe(() => {})();
  originalService.set(undefined); assert.equal(facade.getSnapshot(), undefined);
  const other = { source: 'codex-message', items: [] }; originalService.set(other); assert.equal(facade.getSnapshot(), other);
});

test('card wrapper keeps original component/props and scopes menu lookup to its observed URL', async () => {
  const adapter = loadAdapter(), { runtime } = runtimeStub(), Original = named('CodexImageToolRow');
  const Wrapper = adapter.cardComponent(Original, runtime), runner = adapter.hooks.runner(Wrapper);
  const image = new ElementStub('img'); image.src = 'blob:preview';
  const surface = new ElementStub('button', 'codexGeneratedImageFrame', [image]), root = new ElementStub('div', '', [surface]);
  const props = { sessionId: 'session-1', block: blockFor(), rpc: runtime.rpc, extra: {}, loadImage: async () => image.src };
  const result = runner.render(props, root);
  assert.equal(result.props.children.type, Original);
  assert.equal(result.props.children.props.extra, props.extra);
  assert.equal(runtime.catalog.find('session-1', 'preview-1').rpc, props.rpc);
  await result.props.children.props.loadImage(props.block.content[0].attachment);
  const event = eventFor(image); result.props.onContextMenuCapture(event);
  assert.equal(runtime.shown.length, 1);
  assert.equal(runtime.shown[0].target.original.assetId, original.assetId);
  assert.equal(event.defaultPrevented, true);
  const ordinary = eventFor(image, { type: 'keydown', key: 'Enter' }); result.props.onKeyDownCapture(ordinary);
  assert.equal(ordinary.defaultPrevented, false);
  image.src = 'blob:unmapped'; result.props.onContextMenuCapture(eventFor(image));
  assert.equal(runtime.shown.length, 1);
  runner.unmount(); assert.equal(runtime.catalog.find('session-1', 'preview-1'), undefined);
});

test('viewer subscription pins originals before card virtualization and uses visible gallery URL', () => {
  const adapter = loadAdapter(), { runtime } = runtimeStub(), state = snapshotStore(undefined);
  const service = { getSnapshot: state.getSnapshot, subscribe: state.subscribe, close() { state.set(undefined); } };
  const cardOwner = Symbol('card');
  runtime.catalog.retain(cardOwner, [recordFor('one'), recordFor('two')], runtime.rpc);
  const image = new ElementStub('img', 'dcsiv-image'); image.src = 'blob:two';
  const root = new ElementStub('div', '', [new ElementStub('div', 'dcsiv-surface', [image])]);
  const runner = adapter.hooks.runner(adapter.viewerComponent(named('DeferredImageViewer'), runtime));
  const rendered = runner.render({ service }, root);
  state.set({ source: 'codex-generated', scope: 'session-1', revision: 1, index: 0,
    items: [{ id: 'one', src: 'blob:one' }, { id: 'two', src: 'blob:two' }] });
  runtime.catalog.release(cardOwner);
  assert.ok(runtime.catalog.find('session-1', 'two'), 'Viewer owner survives card unmount');
  rendered.props.onContextMenuCapture(eventFor(image));
  assert.equal(runtime.shown[0].target.attachment.attachmentId, 'two', 'Current DOM image beats initial index=0');
  assert.equal(runtime.viewerOpen, true);
  state.set(undefined);
  assert.equal(runtime.catalog.find('session-1', 'two'), undefined);
  assert.equal(runtime.viewerOpen, false);
  runner.unmount(); assert.equal(runtime.viewers.size, 0);
});

test('key guard lets menu process Escape/arrows but blocks the later original viewer document listener', async () => {
  const adapter = loadAdapter(), active = snapshotStore(), { runtime } = runtimeStub();
  runtime.viewerOpen = true;
  const stop = adapter.installViewerKeyGuard({ contextMenus: { active } }, runtime);
  let viewerKeys = 0, menuKeys = 0;
  adapter.document.addEventListener('keydown', () => viewerKeys++);
  active.set({ kind: MENU });
  for (const key of ['ArrowLeft', 'ArrowRight', 'Escape']) {
    const event = eventFor(undefined, { type: 'keydown', key });
    adapter.window.emit('keydown', event, true);
    menuKeys++; // Simulated React portal handling runs before document bubble.
    if (key === 'Escape') active.set(null); // Same event must remain protected after synchronous close.
    adapter.document.emit('keydown', event);
  }
  assert.equal(menuKeys, 3); assert.equal(viewerKeys, 0);
  await flush();
  const afterClose = eventFor(undefined, { type: 'keydown', key: 'ArrowRight' });
  adapter.window.emit('keydown', afterClose, true); adapter.document.emit('keydown', afterClose);
  assert.equal(viewerKeys, 1);
  active.set({ kind: 'another-plugin-menu' });
  const unrelated = eventFor(undefined, { type: 'keydown', key: 'Escape' });
  adapter.window.emit('keydown', unrelated, true); adapter.document.emit('keydown', unrelated);
  assert.equal(viewerKeys, 2);
  stop(); assert.equal(adapter.window.count(), 0); assert.equal(adapter.document.count(), 1);
});

test('attachment busy and throwing paths release the actual draft objects, not ids', () => {
  const adapter = loadAdapter(), files = [new File([payload], 'original.png', { type: 'image/png' })];
  for (const mode of ['busy', 'throw', 'ok']) {
    const drafts = [{ id: 'draft-1', owner: {} }]; let released, upload, receivedIds;
    const ctx = { sessions: { subagentAddress: () => undefined }, conversation: {
      createDrafts(sid, suppliedFiles, value) { assert.equal(sid, 'session-1'); assert.equal(suppliedFiles, files); upload = value; return drafts; },
      releaseDraftAttachments(value) { released = value; },
    } };
    const input = { addAttachments(ids) { receivedIds = ids; if (mode === 'throw') throw new Error('input-failure'); return mode === 'ok'; } };
    if (mode === 'ok') adapter.attachFiles(ctx, input, files, 'session-1');
    else assert.throws(() => adapter.attachFiles(ctx, input, files, 'session-1'), mode === 'busy' ? /busy/u : /input-failure/u);
    assert.deepEqual(Array.from(receivedIds), ['draft-1']); assert.equal(upload, true);
    assert.equal(released, mode === 'ok' ? undefined : drafts);
  }
  let upload;
  adapter.attachFiles({ sessions: { subagentAddress: () => 'child-address' }, conversation: {
    createDrafts(_sid, _files, value) { upload = value; return []; }, releaseDraftAttachments() {},
  } }, { addAttachments: () => true }, files, 'session-1');
  assert.equal(upload, false);
});

test('controllerOperation reference is released on success, callback failure and readiness failure', async () => {
  const adapter = loadAdapter();
  for (const mode of ['ok', 'callback-failure', 'ready-failure']) {
    let releases = 0, retained, operationRan = false;
    const actx = {};
    const ctx = { sessions: { retain(id, options) { retained = { id, options }; return {
      ready: mode === 'ready-failure' ? Promise.reject(new Error('not-ready')) : Promise.resolve(),
      binding: { ctx: actx }, release() { releases++; },
    }; } } };
    const promise = adapter.withSession(ctx, 'session-1', async value => {
      operationRan = true; assert.equal(value, actx);
      if (mode === 'callback-failure') throw new Error('callback-failed');
      return 42;
    });
    if (mode === 'ok') assert.equal(await promise, 42); else await assert.rejects(promise);
    assert.equal(retained.id, 'session-1'); assert.equal(retained.options.source, 'controllerOperation');
    assert.equal(operationRan, mode !== 'ready-failure'); assert.equal(releases, 1);
  }
});

test('menu provider refuses invalid originals and copy/download call the original byte reader', async () => {
  const adapter = loadAdapter(), { runtime } = runtimeStub();
  let provider, rpcReads = 0, reads = [];
  const rawRpc = runtime.rpc;
  runtime.rpc = { call(...args) { rpcReads++; return rawRpc.call(...args); } };
  const disposers = [];
  const ctx = { effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    contextMenus: { register(value) { provider = value; return () => {}; }, notify() {} },
    fileActions: {
      async copyImage(source) { reads.push(await source.read()); },
      async save(source, mode) { assert.equal(mode, 'download'); reads.push(await source.read()); return { status: 'requested' }; },
    },
  };
  const stop = adapter.installMenus(ctx, runtime, key => key);
  for (const ref of [undefined, { ...original, bytes: 0 }, { ...original, mediaType: 'image/jpeg' }]) {
    assert.equal(provider.resolve({ original: ref, sessionId: 'session-1', src: 'blob:preview' }).length, 0);
  }
  assert.equal(rpcReads, 0); assert.equal(reads.length, 0);
  const actions = provider.resolve({ original, sessionId: 'session-1', src: 'blob:preview' });
  assert.deepEqual(Array.from(actions, action => action.id), ['open', 'add', 'copy', 'reveal', 'download']);
  assert.equal(actions.find(action => action.id === 'reveal').disabled, true);
  await actions.find(action => action.id === 'copy').run();
  await actions.find(action => action.id === 'download').run();
  assert.equal(rpcReads, 2);
  for (const blob of reads) { assert.equal(blob.type, 'image/png'); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), payload); }
  stop(); for (const dispose of disposers.reverse()) dispose();
});

test('facade request replacement clears aliases and ignores late old-request reload results', async () => {
  const adapter = loadAdapter(), aliases = new Map();
  let finishOld;
  const oldPending = new Promise(resolve => { finishOld = resolve; });
  let oldLoads = 0;
  const oldRequest = { source: 'codex-generated', scope: 'session-1', revision: 1, items: [{
    id: 'same-preview-id', src: 'blob:old-preview', reload: () => ++oldLoads === 1 ? Promise.resolve('blob:old-retry') : oldPending,
  }] };
  const state = snapshotStore(oldRequest);
  const facade = adapter.viewerFacade({ getSnapshot: state.getSnapshot, subscribe: state.subscribe }, aliases);
  const oldWrapped = facade.getSnapshot();
  await oldWrapped.items[0].reload();
  assert.ok(aliases.get('same-preview-id').has('blob:old-retry'));
  const late = oldWrapped.items[0].reload();
  const nextRequest = { source: 'codex-generated', scope: 'session-2', revision: 2, items: [{
    id: 'same-preview-id', src: 'blob:new-preview', reload: async () => 'blob:new-retry',
  }] };
  state.set(nextRequest);
  const nextWrapped = facade.getSnapshot();
  assert.equal(aliases.size, 0, 'Request/scope change must clear old aliases even for the same image id');
  assert.equal(facade.getSnapshot(), nextWrapped);
  await nextWrapped.items[0].reload();
  finishOld('blob:late-old-retry');
  assert.equal(await late, 'blob:late-old-retry', 'Original retry result still returns to its original caller');
  assert.deepEqual(Array.from(aliases.get('same-preview-id')), ['blob:new-retry']);
  state.set(undefined); facade.getSnapshot();
  assert.equal(aliases.size, 0, 'Closing viewer also drops aliases');
});

test('same-props generation rerender retains card metadata again without reusing prior URL aliases', async () => {
  const adapter = loadAdapter(), { runtime, generation } = runtimeStub();
  const runner = adapter.hooks.runner(adapter.cardComponent(named('CodexImageToolRow'), runtime));
  const image = new ElementStub('img'); image.src = 'blob:old';
  const root = new ElementStub('div', '', [new ElementStub('button', 'codexGeneratedImageFrame', [image])]);
  let finishOld, calls = 0;
  const oldPending = new Promise(resolve => { finishOld = resolve; });
  const props = { sessionId: 'session-1', block: blockFor(), rpc: runtime.rpc,
    loadImage: () => ++calls === 1 ? Promise.resolve('blob:old') : calls === 2 ? oldPending : Promise.resolve('blob:new') };
  const first = runner.render(props, root);
  await first.props.children.props.loadImage(props.block.content[0].attachment);
  first.props.onContextMenuCapture(eventFor(image));
  assert.equal(runtime.shown.length, 1);
  const lateOldLoad = first.props.children.props.loadImage(props.block.content[0].attachment);
  runtime.catalog.clear();
  assert.equal(runtime.catalog.find('session-1', 'preview-1'), undefined);
  generation.set(1);
  const second = runner.render(props, root); // Explicit hook-stub rerender, not a real React scheduler assertion.
  assert.ok(runtime.catalog.find('session-1', 'preview-1'), 'Changed generation must rerun owner retain despite identical props');
  assert.notEqual(second.props.children.props.loadImage, first.props.children.props.loadImage);
  second.props.onContextMenuCapture(eventFor(image));
  assert.equal(runtime.shown.length, 1, 'Previous-generation URL must not resolve in a fresh generation');
  finishOld('blob:late-old'); await lateOldLoad;
  image.src = 'blob:late-old'; second.props.onContextMenuCapture(eventFor(image));
  assert.equal(runtime.shown.length, 1, 'Late old loader writes only to the old generation map');
  await second.props.children.props.loadImage(props.block.content[0].attachment);
  image.src = 'blob:new'; second.props.onContextMenuCapture(eventFor(image));
  assert.equal(runtime.shown.length, 2);
  assert.equal(runtime.shown[1].target.src, 'blob:new');
  runner.unmount();
  assert.equal(runtime.catalog.find('session-1', 'preview-1'), undefined);
});

test('Add aborts during suspended controllerOperation readiness after reading and always releases reference', async () => {
  const adapter = loadAdapter(), { runtime } = runtimeStub();
  const operation = new AbortController();
  runtime.operationSignal = () => operation.signal;
  let provider, releaseReady, signalRetained;
  const ready = new Promise(resolve => { releaseReady = resolve; });
  const retained = new Promise(resolve => { signalRetained = resolve; });
  let reads = 0, releases = 0, created = 0, inputLookups = 0, attachments = 0, navigations = 0, notices = 0;
  const originalRpc = runtime.rpc;
  runtime.rpc = { call(...args) { reads++; return originalRpc.call(...args); } };
  const disposers = [];
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    contextMenus: { register(value) { provider = value; return () => {}; }, notify() { notices++; } },
    sessions: {
      retain(sessionId, options) {
        assert.equal(sessionId, 'session-1'); assert.equal(options.source, 'controllerOperation');
        assert.equal(reads, 1, 'Byte read must complete before the reference is retained');
        signalRetained();
        return { ready, binding: { ctx: {} }, release() { releases++; } };
      }, subagentAddress: () => undefined,
    },
    conversation: {
      input: { for() { inputLookups++; return { addAttachments() { attachments++; return true; } }; } },
      createDrafts() { created++; return [{ id: 'draft-never-created' }]; }, releaseDraftAttachments() {},
    },
    uiWorkspace: { openSession() { navigations++; } },
  };
  const stop = adapter.installMenus(ctx, runtime, key => key);
  const add = provider.resolve({ original, sessionId: 'session-1', src: 'blob:preview' }).find(action => action.id === 'add');
  const pending = add.run();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await retained;
  assert.equal(releases, 0);
  assert.equal(created, 0);
  operation.abort();
  assert.equal(runtime.lifetime.signal.aborted, false, 'Connection operation cancellation is independent of plugin lifetime');
  releaseReady();
  await rejected;
  assert.equal(releases, 1);
  assert.equal(inputLookups, 0);
  assert.equal(created, 0);
  assert.equal(attachments, 0);
  assert.equal(navigations, 0);
  assert.equal(notices, 0);
  stop(); for (const dispose of disposers.reverse()) dispose();
});

const userBytes = Buffer.from('user-sent image bytes');
const userRef = { attachmentId: 'sha256:' + createHash('sha256').update(userBytes).digest('hex'),
  mediaType: 'image/png', bytes: userBytes.length, width: 4, height: 5, name: 'upload.png' };

test('keyless enhanced previews are wrapped below their own priority and keep the upstream inject', async () => {
  const adapter = loadAdapter(), slots = slotStub(), name = 'conversation.chat.user.images';
  slots.declare(name);
  const inject = () => ({ sessionId: 'session-1' });
  const original = named('MessageImagePreviews');
  const remove = slots.register({ name, priority: -10, inject }, original);
  const stop = adapter.installWrapper({ slots }, { name, component: 'MessageImagePreviews', mode: 'gallery' }, runtimeStub().runtime);
  await flush();
  const rows = slots.entries(name);
  assert.equal(rows.length, 2);
  const wrapper = rows.find(entry => entry.component !== original);
  assert.equal(wrapper.options.name, name);
  assert.equal(wrapper.options.priority, -30);
  assert.equal(wrapper.options.key, undefined);
  assert.equal(wrapper.options.id, undefined);
  assert.equal(wrapper.inject, inject, 'Renderer, not wrapper, must execute/bind upstream inject');
  remove(); await flush();
  assert.equal(slots.entries(name).length, 0);
  stop();
});

test('gallery wrapper maps the rendered thumbnail to its durable attachment before opening our menu', async () => {
  const adapter = loadAdapter(), { runtime } = runtimeStub();
  const Original = named('MessageImagePreviews');
  const runner = adapter.hooks.runner(adapter.galleryComponent(Original, runtime));
  const first = new ElementStub('img'); first.src = 'blob:first';
  const second = new ElementStub('img'); second.src = 'blob:second';
  const root = new ElementStub('div', '', [new ElementStub('button', 'codexImageThumb', [first]), new ElementStub('button', 'codexImageThumb', [second])]);
  const other = { attachmentId: 'sha256:' + 'f'.repeat(64), mediaType: 'image/jpeg', bytes: 2, width: 1, height: 1 };
  const props = { sessionId: 'session-1', images: [{ attachment: userRef }, { attachment: other }],
    loadImage: async attachment => attachment === userRef ? 'blob:first' : 'blob:second' };
  const rendered = runner.render(props, root);
  assert.equal(rendered.props.children.type, Original);
  await rendered.props.children.props.loadImage(userRef);
  await rendered.props.children.props.loadImage(other);
  rendered.props.onContextMenuCapture(eventFor(first));
  assert.equal(runtime.shown.length, 1);
  assert.equal(runtime.shown[0].target.user.attachment.attachmentId, userRef.attachmentId);
  assert.equal(runtime.shown[0].target.src, 'blob:first');
  rendered.props.onKeyDownCapture(eventFor(root.children[1], { type: 'keydown', key: 'ContextMenu' }));
  assert.equal(runtime.shown.length, 2);
  assert.equal(runtime.shown[1].target.user.attachment.attachmentId, other.attachmentId);
  second.src = 'blob:remapped';
  rendered.props.onContextMenuCapture(eventFor(second));
  assert.equal(runtime.shown.length, 3);
  assert.equal(runtime.shown[2].target.user.attachment.attachmentId, other.attachmentId);
  rendered.props.onContextMenuCapture(eventFor(new ElementStub('img')));
  rendered.props.onKeyDownCapture(eventFor(second, { type: 'keydown', key: 'Enter' }));
  assert.equal(runtime.shown.length, 3);
  rendered.props.onContextMenuCapture(eventFor(first, { defaultPrevented: true }));
  assert.equal(runtime.shown.length, 3);
  runner.unmount();
});

test('menu provider serves user-sent images through the verified durable attachment read', async () => {
  const adapter = loadAdapter(), { runtime } = runtimeStub();
  let provider, requests = [], blobs = [];
  runtime.remoteSession = { async attachment(request) {
    requests.push(request);
    return { ok: true, value: { attachment: userRef, data: userBytes.toString('base64') } };
  } };
  const disposers = [];
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    contextMenus: { register(value) { provider = value; return () => {}; }, notify() {} },
    fileActions: {
      async copyImage(source) { blobs.push(await source.read()); },
      async save(source, mode) { assert.equal(mode, 'download'); blobs.push(await source.read()); return { status: 'requested' }; },
    },
  };
  const stop = adapter.installMenus(ctx, runtime, key => key);
  assert.equal(provider.resolve({ user: { sessionId: 'session-1', attachment: { ...userRef, bytes: 0 } }, src: 'blob:user' }).length, 0);
  assert.equal(provider.resolve({ user: { sessionId: '', attachment: userRef }, src: 'blob:user' }).length, 0);
  const actions = provider.resolve({ user: { sessionId: 'session-1', attachment: userRef }, src: 'blob:user' });
  assert.deepEqual(Array.from(actions, action => action.id), ['open', 'add', 'copy', 'reveal', 'download']);
  assert.equal(actions.find(action => action.id === 'reveal').disabled, true, 'No host path is known for an uploaded image');
  await actions.find(action => action.id === 'copy').run();
  await actions.find(action => action.id === 'download').run();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].sessionId, 'session-1');
  assert.equal(requests[0].attachment.attachmentId, userRef.attachmentId);
  assert.equal(requests[0].attachment.mediaType, userRef.mediaType);
  assert.equal(requests[0].attachment.bytes, userRef.bytes);
  assert.equal(requests[0].attachment.name, userRef.name);
  for (const blob of blobs) { assert.equal(blob.type, 'image/png'); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), userBytes); }
  runtime.remoteSession = { async attachment() { return { ok: false, error: { code: 'attachment/missing', message: 'gone' } }; } };
  await assert.rejects(provider.resolve({ user: { sessionId: 'session-1', attachment: userRef }, src: 'blob:user' })
    .find(action => action.id === 'copy').run(), /unavailable/u);
  stop(); for (const dispose of disposers.reverse()) dispose();
});
