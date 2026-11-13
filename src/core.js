// Original chunk protocol/verification adapted from dsh-codex-subscription 3.2.6
// (MIT, copyright WSL043). This companion never reads preview bytes as originals.
const MAX_ORIGINAL_BYTES = 48 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const ASSET_ID = /^img_[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FIELDS = ['assetId', 'mediaType', 'bytes', 'width', 'height', 'name', 'sha256'];
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const validSession = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const validAttachmentId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

export function decodeOriginal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.assetId !== 'string' || !ASSET_ID.test(value.assetId)
    || value.mediaType !== 'image/png'
    || !positiveInteger(value.bytes) || value.bytes > MAX_ORIGINAL_BYTES
    || !positiveInteger(value.width) || !positiveInteger(value.height)
    || typeof value.name !== 'string' || !NAME.test(value.name)
    || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) return undefined;
  return Object.fromEntries(FIELDS.map(field => [field, value[field]]));
}

export function sameOriginal(left, right) {
  const a = decodeOriginal(left), b = decodeOriginal(right);
  return a !== undefined && b !== undefined && FIELDS.every(field => a[field] === b[field]);
}

export function originalFromBlock(block) {
  const meta = block?.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)
    || meta.kind !== 'codex-subscription-image' || meta.schemaVersion !== 1) return undefined;
  return decodeOriginal(meta.original);
}

export function localPathFromBlock(block, original) {
  const ref = decodeOriginal(original);
  if (!ref || !sameOriginal(originalFromBlock(block), ref)) return undefined;
  const suffix = `/dsh-codex-subscription/images/v1/${ref.assetId.slice(4, 6)}/${ref.assetId}/original`;
  for (const part of Array.isArray(block?.content) ? block.content : []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    for (const match of part.text.matchAll(/Original PNG saved on the DSH host at:\s*("(?:[^"\\]|\\.)*")\./gu)) {
      try {
        const path = JSON.parse(match[1]);
        if (typeof path !== 'string' || /[\u0000-\u001f\u007f]/u.test(path)) continue;
        const normalized = path.replace(/\\/gu, '/');
        const windows = /^[A-Za-z]:\//u.test(normalized);
        if (!windows && !(normalized.startsWith('/') && !normalized.startsWith('//'))) continue;
        if (normalized.split('/').some(segment => segment === '.' || segment === '..')) continue;
        if ((windows ? normalized.slice(2) : normalized).includes(':')) continue;
        if (normalized.endsWith(suffix)) return path;
      } catch { /* A hint is optional, not permission to infer a host home. */ }
    }
  }
  return undefined;
}

export function collectGeneratedItems(props) {
  if (!validSession(props?.sessionId)) return [];
  const blocks = Array.isArray(props?.node?.data?.blocks) ? props.node.data.blocks : props?.block ? [props.block] : [];
  return blocks.flatMap(block => {
    const original = originalFromBlock(block);
    const image = Array.isArray(block?.content) ? block.content.find(part => part?.type === 'image' && part.attachment) : undefined;
    if (!original || !image || !validAttachmentId(image.attachment.attachmentId)) return [];
    return [{
      attachment: { ...image.attachment },
      original,
      localPath: localPathFromBlock(block, original),
      sessionId: props.sessionId,
    }];
  });
}

function decodeChunk(encoded, expectedLength) {
  if (typeof encoded !== 'string' || encoded.length === 0
    || encoded.length !== Math.ceil(expectedLength / 3) * 4) {
    throw new Error('Invalid original image chunk');
  }
  let binary;
  try { binary = atob(encoded); } catch { throw new Error('Invalid original image chunk'); }
  if (binary.length !== expectedLength || binary.length > CHUNK_BYTES || btoa(binary) !== encoded) {
    throw new Error('Invalid original image chunk');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function readOriginal(rpc, sessionId, original, { signal } = {}) {
  signal?.throwIfAborted();
  const ref = decodeOriginal(original);
  if (!ref || !validSession(sessionId) || typeof rpc?.call !== 'function') throw new Error('Invalid original image request');
  const data = new Uint8Array(ref.bytes);
  for (let offset = 0; offset < ref.bytes;) {
    signal?.throwIfAborted();
    const response = await rpc.call('/codex-subscription', 'image/original/chunk', {
      sessionId, assetId: ref.assetId, offset,
    }, signal);
    signal?.throwIfAborted();
    if (response?.ok !== true) throw new Error('Original image is unavailable');
    const chunk = response.value;
    const expectedLength = Math.min(CHUNK_BYTES, ref.bytes - offset);
    const expectedDone = offset + expectedLength === ref.bytes;
    if (!sameOriginal(chunk?.ref, ref) || chunk.offset !== offset || chunk.done !== expectedDone) {
      throw new Error('Original image metadata changed');
    }
    const bytes = decodeChunk(chunk.encoded, expectedLength);
    data.set(bytes, offset);
    offset += bytes.length;
  }
  signal?.throwIfAborted();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  signal?.throwIfAborted();
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== ref.sha256) throw new Error('Original image integrity check failed');
  return data;
}

/** User-sent images arrive as durable attachment references, not Codex originals. */
const MEDIA_TYPE = /^image\/[a-z0-9.+-]{1,64}$/u;
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;

/** Accept only a complete, self-consistent durable image reference for one session. */
export function decodeUserImage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validSession(value.sessionId)) return undefined;
  const attachment = value.attachment;
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return undefined;
  const { attachmentId, mediaType } = attachment;
  if (!validAttachmentId(attachmentId) || !/[^\\u0000-\\u001f\\u007f]/u.test(attachmentId)) return undefined;
  if (typeof mediaType !== 'string' || !MEDIA_TYPE.test(mediaType)) return undefined;
  if (!positiveInteger(attachment.bytes) || attachment.bytes > MAX_IMAGE_BYTES) return undefined;
  if (!positiveInteger(attachment.width) || !positiveInteger(attachment.height)) return undefined;
  if (attachment.width * attachment.height > 2 ** 27) return undefined;
  const name = typeof attachment.name === 'string' && NAME.test(attachment.name) ? attachment.name : undefined;
  return { sessionId: value.sessionId, attachment: {
    attachmentId, mediaType, bytes: attachment.bytes, width: attachment.width, height: attachment.height,
    ...name === undefined ? {} : { name },
  } };
}

/**
 * Read one durable attachment through the Session gateway, verifying the reference,
 * the announced byte length and (when the id is a digest) the stored object digest.
 * @param remoteSession - `ctx.remote.session` with the `attachment` operation.
 * @param sessionId - Session that owns the attachment permission scope.
 * @param image - `{ attachment }` reference taken from rendered chat images.
 * @param options - optional abort signal.
 */
export async function readUserImage(remoteSession, sessionId, image, { signal } = {}) {
  const ref = decodeUserImage({ sessionId, attachment: image?.attachment });
  if (!ref || typeof remoteSession?.attachment !== 'function') throw new Error('Invalid image request');
  signal?.throwIfAborted();
  const result = await remoteSession.attachment({ sessionId: ref.sessionId, attachment: ref.attachment });
  signal?.throwIfAborted();
  if (result?.ok !== true) throw new Error('Image is unavailable');
  const value = result.value;
  if (!value || typeof value.data !== 'string' || value.attachment?.attachmentId !== ref.attachment.attachmentId) {
    throw new Error('Image metadata changed');
  }
  let binary;
  try { binary = atob(value.data); } catch { throw new Error('Invalid image payload'); }
  if (binary.length !== ref.attachment.bytes) throw new Error('Image integrity check failed');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const digest = ref.attachment.attachmentId.startsWith('sha256:') ? ref.attachment.attachmentId.slice(7) : undefined;
  if (digest !== undefined && SHA256.test(digest)) {
    const actual = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    if ([...new Uint8Array(actual)].map(byte => byte.toString(16).padStart(2, '0')).join('') !== digest) {
      throw new Error('Image integrity check failed');
    }
  }
  signal?.throwIfAborted();
  return { bytes, attachment: ref.attachment };
}

export class Catalog {
  #owners = new Map();

  retain(owner, items, rpc) {
    if (owner === undefined || owner === null) throw new TypeError('A catalog owner token is required');
    const records = (Array.isArray(items) ? items : []).flatMap(item => {
      const original = decodeOriginal(item?.original);
      if (!original || !validSession(item?.sessionId) || !validAttachmentId(item?.attachment?.attachmentId)
        || typeof rpc?.call !== 'function') return [];
      return [{ target: {
        attachment: { ...item.attachment }, original,
        localPath: typeof item.localPath === 'string' ? item.localPath : undefined,
        sessionId: item.sessionId,
      }, rpc }];
    });
    this.#owners.set(owner, records);
  }

  release(owner) { this.#owners.delete(owner); }
  clear() { this.#owners.clear(); }

  find(sessionId, attachmentId) {
    if (!validSession(sessionId) || !validAttachmentId(attachmentId)) return undefined;
    let found;
    const paths = new Set();
    for (const records of this.#owners.values()) {
      for (const record of records) {
        const target = record.target;
        if (target.sessionId !== sessionId || target.attachment.attachmentId !== attachmentId) continue;
        if (found && !sameOriginal(found.target.original, target.original)) return undefined;
        found ??= record;
        if (target.localPath !== undefined) paths.add(target.localPath);
      }
    }
    if (!found) return undefined;
    // Return copies so menu consumers cannot poison future identity checks.
    return { rpc: found.rpc, target: {
      ...found.target,
      attachment: { ...found.target.attachment },
      original: { ...found.target.original },
      localPath: paths.size === 1 ? paths.values().next().value : undefined,
    } };
  }
}

export function matchViewerImage(request, src, catalog, aliases = new Map()) {
  if (request?.source !== 'codex-generated' || !validSession(request.scope)
    || typeof src !== 'string' || !src || !Array.isArray(request.items)
    || typeof catalog?.find !== 'function') return undefined;
  const matches = request.items.filter(item => item && validAttachmentId(item.id)
    && (item.src === src || aliases?.get?.(item.id)?.has?.(src) === true));
  const ids = new Set(matches.map(item => item.id));
  if (ids.size !== 1) return undefined;
  return catalog.find(request.scope, ids.values().next().value);
}
