/**
 * dsh-live-doc — image assets.
 *
 * Every document owns a folder of images next to its JSON file, so a picture
 * pasted into the panel survives a restart, survives an export, and embeds into
 * the .docx without the exporter having to reach the internet or the workspace.
 *
 * A block stores `src: "asset:<file>"`; the panel turns that into the
 * `/live-doc/asset?doc=…&name=…` route, and the DOCX writer reads the file back
 * through {@link readAsset}. Remote `http(s)` images are kept as-is and are not
 * downloaded — the exporter skips them rather than fetching anything.
 *
 * @module dsh-live-doc/assets
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Largest single image accepted from the panel or the workspace. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** `asset:` prefix that marks a stored image reference. */
export const ASSET_PREFIX = 'asset:';

/** Strict file-name shape for anything the asset route will read. */
const ASSET_NAME = /^[a-z0-9]{8,40}\.(png|jpg|jpeg|gif|webp|bmp)$/;

/** Image extensions we accept, keyed by sniffed container. */
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/** Directory holding one document's images. */
export function assetDirectory(storeDirectory, docId) {
  return path.join(storeDirectory, 'assets', String(docId));
}

/** Whether a stored block source points at a local asset. */
export function isAssetSrc(src) {
  return typeof src === 'string' && src.startsWith(ASSET_PREFIX);
}

/** The file name inside `asset:<name>`. */
export function assetName(src) {
  return isAssetSrc(src) ? src.slice(ASSET_PREFIX.length) : '';
}

/** Whether a file name is safe to pass to the asset route. */
export function isSafeAssetName(name) {
  return ASSET_NAME.test(String(name ?? ''));
}

/** Content type for a stored asset name. */
export function mimeOf(name) {
  const ext = String(name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Read the intrinsic pixel size of a PNG / JPEG / GIF / WebP / BMP buffer.
 *
 * The DOCX writer needs the real aspect ratio to give Word an extent that does
 * not distort the picture, and the browser already knows it — but the export
 * runs on the host, so the size is measured once at upload time and stored on
 * the block.
 * @param buffer - the encoded image.
 * @returns `{ ext, px, py }`, with zeroes when the format is not recognized.
 */
export function imageInfo(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.length < 12) return { ext: '', px: 0, py: 0 };
  // PNG: signature + IHDR width/height at bytes 16..24.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: 'png', px: bytes.readUInt32BE(16), py: bytes.readUInt32BE(20) };
  }
  // GIF: logical screen width/height, little endian at bytes 6..10.
  if (bytes.subarray(0, 3).toString('latin1') === 'GIF') {
    return { ext: 'gif', px: bytes.readUInt16LE(6), py: bytes.readUInt16LE(8) };
  }
  // BMP: DIB header width/height (signed) at bytes 18..26.
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return {
      ext: 'bmp',
      px: Math.abs(bytes.readInt32LE(18)),
      py: Math.abs(bytes.readInt32LE(22)),
    };
  }
  // WebP: RIFF container, three possible chunk layouts.
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = bytes.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X') {
      return {
        ext: 'webp',
        px: 1 + bytes.readUIntLE(24, 3),
        py: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (chunk === 'VP8 ') {
      return {
        ext: 'webp',
        px: bytes.readUInt16LE(26) & 0x3fff,
        py: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return {
        ext: 'webp',
        px: 1 + (bits & 0x3fff),
        py: 1 + ((bits >> 14) & 0x3fff),
      };
    }
    return { ext: 'webp', px: 0, py: 0 };
  }
  // JPEG: walk the marker chain to the first Start-Of-Frame segment.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      // SOF0..SOF15, excluding DHT (0xc4), JPG (0xc8) and DAC (0xcc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { ext: 'jpg', px: bytes.readUInt16BE(offset + 7), py: bytes.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
    return { ext: 'jpg', px: 0, py: 0 };
  }
  return { ext: '', px: 0, py: 0 };
}

/**
 * Store one image for a document.
 * @param storeDirectory - the plugin's document directory.
 * @param docId - owning document.
 * @param bytes - encoded image bytes.
 * @returns `{ src, px, py }` for the block, or throws for unsupported content.
 */
export function saveAsset(storeDirectory, docId, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length === 0) throw new Error('图片是空的。');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB，请先压缩或缩放。`);
  }
  const info = imageInfo(buffer);
  if (info.ext.length === 0) throw new Error('只支持 PNG / JPEG / GIF / WebP / BMP 图片。');
  const digest = createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  const name = `${digest}.${info.ext}`;
  const directory = assetDirectory(storeDirectory, docId);
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, name);
  if (!existsSync(target)) writeFileSync(target, buffer);
  return { src: `${ASSET_PREFIX}${name}`, px: info.px, py: info.py };
}

/**
 * Read a stored asset back.
 * @returns the bytes, or `undefined` when the name or file is not there.
 */
export function readAsset(storeDirectory, docId, name) {
  if (!isSafeAssetName(name)) return undefined;
  const target = path.join(assetDirectory(storeDirectory, docId), name);
  if (!existsSync(target)) return undefined;
  return readFileSync(target);
}

/** One stored image as an absolute path, for a Markdown side export. */
export function assetPath(storeDirectory, docId, name) {
  return path.join(assetDirectory(storeDirectory, docId), name);
}
