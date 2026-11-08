import * as React from 'react';
import { jsx } from 'react/jsx-runtime';
import { Catalog, collectGeneratedItems, decodeOriginal, localPathFromBlock, readOriginal, matchViewerImage } from './core.js';

const ID = 'dsh-image-context-menu';
const MENU = `${ID}.original`;
const TAB = `${ID}.image`;
const SPECS = [
  { name: 'conversation.chat.node', key: 'codex-image-output', component: 'CodexImageOutput', mode: 'card' },
  { name: 'tool.call.toolview', key: 'codex_image_generate', component: 'CodexImageToolRow', mode: 'card' },
  { name: 'shell.overlay', id: 'codex-subscription-image-viewer', component: 'DeferredImageViewer', mode: 'viewer' },
];
const COPY = {
  zh: { open: '在新标签页中打开图像', add: '添加到聊天', copy: '复制图像', reveal: '在资源管理器中打开', revealMac: '在 Finder 中显示', download: '下载副本', image: '图片', loading: '正在读取原图…', failed: '图片操作失败，请重试', added: '已添加到聊天', copied: '已复制图像', saved: '已下载副本', requested: '已开始下载', popup: '请允许弹出窗口后重试', unavailable: '原图或来源信息不可用' },
  en: { open: 'Open image in new tab', add: 'Add to chat', copy: 'Copy image', reveal: 'Show in file manager', revealMac: 'Show in Finder', download: 'Download a copy', image: 'Image', loading: 'Reading original image…', failed: 'Image action failed. Please try again.', added: 'Added to chat', copied: 'Image copied', saved: 'Copy downloaded', requested: 'Download started', popup: 'Allow pop-ups and try again', unavailable: 'Original image or source metadata unavailable' },
};

/** Only keyboard menu gestures; ordinary click/zoom/edit behavior belongs to upstream. */
function isMenuKey(event) {
  return !event.repeat && !event.nativeEvent?.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey);
}
function pointOf(event, element) {
  if (event.type === 'keydown' || !event.clientX && !event.clientY) {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom };
  }
  return { x: event.clientX, y: event.clientY };
}
function consume(event) {
  event.preventDefault();
  event.stopPropagation();
  event.nativeEvent?.stopImmediatePropagation?.();
}
function imageAt(root, event, viewer = false) {
  const element = event.target;
  if (!(element instanceof Element) || !root?.contains(element)) return;
  let surface = element.closest(viewer ? '.dcsiv-surface' : '.codexGeneratedImageFrame');
  if (!surface && viewer && event.type === 'keydown' && element.matches('.dcsiv-root, .dcsiv-stage')) surface = root.querySelector('.dcsiv-surface');
  if (!surface || !root.contains(surface)) return;
  return { surface, image: surface.querySelector(viewer ? 'img.dcsiv-image' : 'img') };
}
function sourceUrl(image) { return image?.currentSrc || image?.src; }
function rememberUrl(map, id, value) {
  if (typeof id !== 'string' || typeof value !== 'string') return;
  let urls = map.get(id);
  if (!urls) map.set(id, urls = new Set());
  urls.add(value);
  if (urls.size > 8) urls.delete(urls.values().next().value);
}

function cardComponent(Original, runtime) {
  return function ImageMenuCard(props) {
    const root = React.useRef(null);
    const owner = React.useRef(Symbol('image-card'));
    const generation = React.useSyncExternalStore(runtime.subscribeGeneration, runtime.getGeneration);
    const urls = React.useMemo(() => new Map(), [generation]);
    const items = React.useMemo(() => collectGeneratedItems(props), [props.block, props.node, props.sessionId]);
    React.useLayoutEffect(() => {
      runtime.catalog.retain(owner.current, items, props.rpc);
      return () => runtime.catalog.release(owner.current);
    }, [items, props.rpc, generation]);
    const loadImage = React.useCallback(async attachment => {
      const src = await props.loadImage(attachment);
      rememberUrl(urls, attachment?.attachmentId, src);
      return src;
    }, [props.loadImage, generation]);
    const show = event => {
      if (event.defaultPrevented || event.type === 'keydown' && !isMenuKey(event)) return;
      const hit = imageAt(root.current, event);
      const src = sourceUrl(hit?.image);
      if (!src) return;
      const candidates = items.filter(item => urls.get(item.attachment.attachmentId)?.has(src));
      const ids = [...new Set(candidates.map(item => item.attachment.attachmentId))];
      if (ids.length !== 1) return;
      const record = runtime.catalog.find(props.sessionId, ids[0]);
      if (!record) return;
      runtime.show({ ...record.target, src }, pointOf(event, hit.surface));
      consume(event);
    };
    return jsx('div', { ref: root, style: { display: 'contents' }, onContextMenuCapture: show, onKeyDownCapture: show, children: jsx(Original, { ...props, loadImage }) });
  };
}

/** Private-service adapter, never mutating or rebinding the upstream instance. */
function viewerFacade(service, aliases) {
  const snapshots = new WeakMap();
  let currentRequest;
  const facade = {};
  const names = new Set();
  for (let object = service; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const name of Object.getOwnPropertyNames(object)) if (name !== 'constructor') names.add(name);
  }
  for (const name of names) if (typeof service[name] === 'function') facade[name] = (...args) => service[name](...args);
  facade.getSnapshot = () => {
    const request = service.getSnapshot();
    if (request !== currentRequest) { aliases.clear(); currentRequest = request; }
    if (!request || request.source !== 'codex-generated' || !Array.isArray(request.items)) return request;
    let wrapped = snapshots.get(request);
    if (!wrapped) {
      wrapped = { ...request, items: request.items.map(item => ({ ...item, reload: typeof item.reload === 'function' ? async (...args) => {
        const src = await item.reload(...args);
        if (service.getSnapshot() === request) rememberUrl(aliases, item.id, src);
        return src;
      } : undefined })) };
      snapshots.set(request, wrapped);
    }
    return wrapped;
  };
  return Object.freeze(facade);
}
function viewerComponent(Original, runtime) {
  return function ImageMenuViewer(props) {
    const root = React.useRef(null);
    const owner = React.useRef(Symbol('image-viewer'));
    const aliases = React.useMemo(() => new Map(), [props.service]);
    const service = React.useMemo(() => viewerFacade(props.service, aliases), [props.service, aliases]);
    React.useLayoutEffect(() => {
      runtime.viewers.add(props.service);
      let previous;
      const pin = () => {
        const request = props.service.getSnapshot();
        if (request !== previous) { runtime.catalog.release(owner.current); previous = request; }
        runtime.viewerOpen = request?.source === 'codex-generated';
        const items = runtime.viewerOpen ? request.items.map(item => runtime.catalog.find(request.scope, item.id)).filter(Boolean) : [];
        runtime.catalog.retain(owner.current, items.map(record => record.target), runtime.rpc);
      };
      pin();
      const unsubscribe = props.service.subscribe(pin);
      return () => { unsubscribe(); runtime.catalog.release(owner.current); runtime.viewers.delete(props.service); runtime.viewerOpen = false; };
    }, [props.service]);
    const show = event => {
      if (event.defaultPrevented || event.type === 'keydown' && !isMenuKey(event)) return;
      const hit = imageAt(root.current, event, true);
      const record = matchViewerImage(props.service.getSnapshot(), sourceUrl(hit?.image), runtime.catalog, aliases);
      if (!hit || !record) return;
      runtime.show({ ...record.target, src: sourceUrl(hit.image) }, pointOf(event, hit.surface));
      consume(event);
    };
    return jsx('div', { ref: root, style: { display: 'contents' }, onContextMenuCapture: show, onKeyDownCapture: show, children: jsx(Original, { ...props, service }) });
  };
}

/** Reconcile one shadowing entry; its own registration never becomes its source. */
function installWrapper(ctx, spec, runtime) {
  return ctx.slots.inject(spec.name, () => {
    let source, dispose, stopped = false, reconciling = false;
    const wrappers = new Set();
    const sync = () => {
      if (stopped || reconciling) return;
      const candidates = ctx.slots.entries(spec.name).filter(entry => !wrappers.has(entry.component) && (spec.key ? entry.options?.key === spec.key : entry.options?.id === spec.id) && entry.component?.name === spec.component && !entry.children && !entry.store);
      const next = candidates.length === 1 ? candidates[0] : undefined;
      if (next === source && (next === undefined || dispose)) return;
      reconciling = true;
      try {
        dispose?.(); dispose = undefined; source = next;
        if (next) {
          const Component = spec.mode === 'viewer' ? viewerComponent(next.component, runtime) : cardComponent(next.component, runtime);
          wrappers.add(Component);
          dispose = ctx.slots.register({ name: spec.name, ...spec.key ? { key: spec.key } : { id: spec.id, order: 20 }, priority: (next.options?.priority ?? 0) - 20, ...next.locale ? { locale: next.locale } : {}, ...next.inject ? { inject: next.inject } : {} }, Component);
        }
      } finally { reconciling = false; }
    };
    const unsubscribe = ctx.slots.subscribe(spec.name, sync);
    sync();
    return () => { stopped = true; unsubscribe(); dispose?.(); };
  });
}

async function withSession(ctx, sessionId, run) {
  const reference = ctx.sessions.retain(sessionId, { source: 'controllerOperation' });
  try {
    await reference.ready;
    return await run(reference.binding.ctx);
  } finally { reference.release(); }
}
function attachFiles(ctx, input, files, sessionId) {
  const drafts = ctx.conversation.createDrafts(sessionId, files, ctx.sessions.subagentAddress(sessionId) === undefined);
  try { if (!input.addAttachments(drafts.map(draft => draft.id))) throw new Error('The composer is busy'); }
  catch (error) { ctx.conversation.releaseDraftAttachments(drafts); throw error; }
}
function openSession(ctx, sessionId) { ctx.uiWorkspace.openSession(sessionId); }

function OriginalImageTab({ useTabInfo, runtime, t }) {
  const { tab } = useTabInfo();
  const target = tab.navigation.params;
  const [state, setState] = React.useState({});
  const generation = React.useSyncExternalStore(runtime.subscribeGeneration, runtime.getGeneration);
  React.useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, runtime.operationSignal()]);
    let url;
    setState({});
    readOriginal(runtime.rpc, target?.sessionId, target?.original, { signal }).then(data => {
      signal.throwIfAborted();
      url = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
      setState({ url });
    }).catch(() => { if (!signal.aborted) setState({ failed: true }); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [target, runtime, generation]);
  const show = event => {
    if (event.defaultPrevented || event.type === 'keydown' && !isMenuKey(event) || !state.url || !decodeOriginal(target?.original)) return;
    runtime.show({ ...target, src: state.url }, pointOf(event, event.currentTarget));
    consume(event);
  };
  return jsx('div', { style: { display: 'grid', placeItems: 'center', width: '100%', height: '100%', overflow: 'auto', background: 'var(--dsw-alias-bg-base)' }, children: state.url ? jsx('img', { src: state.url, alt: target.original.name, tabIndex: 0, onContextMenu: show, onKeyDown: show, style: { display: 'block', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } }) : jsx('span', { role: 'status', children: t(state.failed ? 'failed' : 'loading') }) });
}

/** Own-menu keys must not also reach Codex 3.2.6's document-level viewer shortcuts. */
function installViewerKeyGuard(ctx, runtime) {
  const marked = new WeakSet();
  let ownMenu = false;
  const refresh = () => {
    const current = ctx.contextMenus.active.getSnapshot();
    if (current) ownMenu = current.kind === MENU;
    else queueMicrotask(() => { if (!ctx.contextMenus.active.getSnapshot()) ownMenu = false; });
  };
  const unsubscribe = ctx.contextMenus.active.subscribe(refresh);
  const capture = event => { if (runtime.viewerOpen && ownMenu) marked.add(event); };
  const bubble = event => { if (marked.has(event)) event.stopImmediatePropagation(); };
  window.addEventListener('keydown', capture, true);
  document.addEventListener('keydown', bubble);
  return () => { unsubscribe(); window.removeEventListener('keydown', capture, true); document.removeEventListener('keydown', bubble); };
}

function installMenus(ctx, runtime, t) {
  const urls = new Set();
  ctx.effect(() => () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }, `${ID}: URLs`);
  return ctx.contextMenus.register({ id: `${ID}.actions`, target: MENU, order: 0, resolve: target => {
    const original = decodeOriginal(target?.original);
    if (!original || typeof target.sessionId !== 'string') return [];
    const operationSignal = runtime.operationSignal();
    const read = signal => readOriginal(runtime.rpc, target.sessionId, original, { signal: signal ? AbortSignal.any([operationSignal, signal]) : operationSignal }).then(data => new Blob([data], { type: 'image/png' }));
    const localPath = typeof target.localPath === 'string' ? localPathFromBlock({ meta: { kind: 'codex-subscription-image', schemaVersion: 1, original }, content: [{ type: 'text', text: `Original PNG saved on the DSH host at: ${JSON.stringify(target.localPath)}.` }] }, original) : undefined;
    const file = { url: target.src, name: original.name, mediaType: 'image/png', read };
    const item = (id, run, disabled = false) => ({ id, label: t(id === 'reveal' && document.documentElement.dataset.platform === 'darwin' ? 'revealMac' : id), failureLabel: t('failed'), disabled, run });
    return [
      item('open', async () => {
        if (window.dshDesktop) return withSession(ctx, target.sessionId, async () => {
          operationSignal.throwIfAborted();
          openSession(ctx, target.sessionId);
          ctx.sidebarRight.openTab(TAB, { params: target });
          runtime.closeViewers();
        });
        const popup = window.open('about:blank', '_blank');
        if (!popup) throw new Error(t('popup'));
        popup.opener = null;
        try {
          const blob = await read();
          operationSignal.throwIfAborted();
          const url = URL.createObjectURL(blob); urls.add(url); popup.location.replace(url);
          if (urls.size > 16) { const oldest = urls.values().next().value; urls.delete(oldest); URL.revokeObjectURL(oldest); }
        } catch (error) { popup.close(); throw error; }
      }),
      item('add', async () => {
        const blob = await read();
        operationSignal.throwIfAborted();
        await withSession(ctx, target.sessionId, async actx => {
          operationSignal.throwIfAborted();
          attachFiles(ctx, ctx.conversation.input.for(actx), [new File([blob], original.name, { type: 'image/png' })], target.sessionId);
          openSession(ctx, target.sessionId);
          runtime.closeViewers();
        });
        ctx.contextMenus.notify(t('added'), true);
      }),
      item('copy', async () => { await ctx.fileActions.copyImage(file); ctx.contextMenus.notify(t('copied'), true); }),
      item('reveal', async () => {
        const result = await ctx.remote.session.openWorkspacePath({ path: localPath, action: 'reveal' }, operationSignal);
        if (!result.ok) throw new Error(t('failed'));
      }, !localPath),
      item('download', async () => { const result = await ctx.fileActions.save(file, 'download'); if (result.status !== 'cancelled') ctx.contextMenus.notify(t(result.status === 'requested' ? 'requested' : 'saved'), true); }),
    ];
  } });
}

export const inject = ['slots', 'locale', 'connection', 'sessions', 'conversation', 'uiWorkspace', 'remote.session', 'contextMenus', 'fileActions', 'sidebarRight', 'sidebarRightTabs'];
export function apply(ctx) {
  const lifetime = new AbortController();
  const catalog = new Catalog();
  const viewers = new Set();
  const generationListeners = new Set();
  let generation = 0, connectionLifetime = new AbortController();
  const rpc = { call(channel, endpoint, payload, signal) {
    if (channel !== '/codex-subscription' || endpoint !== 'image/original/chunk') throw new Error('Unsupported image request');
    return ctx.connection.rpc.call('/api', 'codex-subscription/image/original/chunk', payload, signal);
  } };
  const runtime = { lifetime, catalog, rpc, viewers, viewerOpen: false,
    getGeneration: () => generation,
    subscribeGeneration: callback => { generationListeners.add(callback); return () => generationListeners.delete(callback); },
    operationSignal: () => AbortSignal.any([lifetime.signal, connectionLifetime.signal]),
    show: (target, point) => {
    if (!lifetime.signal.aborted && decodeOriginal(target?.original)) ctx.contextMenus.open({ kind: MENU, value: target }, point);
  }, closeViewers: () => { for (const viewer of viewers) viewer.close(); } };
  ctx.effect(() => ctx.locale.register(ID, COPY), `${ID}: locale`);
  const t = ctx.locale.bind(ID);
  ctx.effect(() => installMenus(ctx, runtime, t), `${ID}: menu`);
  ctx.effect(() => installViewerKeyGuard(ctx, runtime), `${ID}: viewer key guard`);
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB, kind: TAB, multiple: true, priority: 'extension', title: () => t('image') }), `${ID}: image tab`);
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB, inject: () => ({ runtime, t }) }, OriginalImageTab));
  for (const spec of SPECS) installWrapper(ctx, spec, runtime);
  ctx.effect(() => ctx.on('connection/reset', () => {
    connectionLifetime.abort(); connectionLifetime = new AbortController();
    catalog.clear(); ctx.contextMenus.close(); runtime.closeViewers();
    generation++; for (const callback of [...generationListeners]) callback();
  }), `${ID}: connection reset`);
  ctx.effect(() => () => { lifetime.abort(); connectionLifetime.abort(); catalog.clear(); ctx.contextMenus.close(); viewers.clear(); generationListeners.clear(); }, `${ID}: lifetime`);
}
