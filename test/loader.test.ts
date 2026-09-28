/**
 * Vitest validation of the VMC/Huffman decoder and the surface renderers.
 *
 * Loads the real `fostral` world shipped in the Vangers repo. Each VMC line must
 * consume exactly `sz_table[i]` bytes — a strong invariant that catches a broken
 * Huffman port. Surface hashes are pinned as a regression baseline.
 *
 * Run: npm test
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { loadPalette, loadVmc, loadVpr, parseWorldConfig } from '../src/loader';
import { renderPrepare } from '../src/luts';
import { VrtMap } from '../src/vmap';
import { buildPalette } from '../src/palette';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.VANGERS_WORLD || path.resolve(__dirname, '../../Vangers/data/thechain/fostral');
const outDir = path.resolve(__dirname, 'out');
const available = fs.existsSync(path.join(dataDir, 'world.ini'));

const LINE_HASH = 'fed77a5d';
const REG_COLOR_HASH = 'ac09fd4a';
const REG_META_HASH = 'f65beb57';

function fnv1a(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

let crcTable: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writePng(file: string, width: number, height: number, rgb: Buffer): void {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    chunks.push(Buffer.concat([len, t, data, crc]));
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  chunk('IHDR', ihdr);
  chunk('IDAT', idat);
  chunk('IEND', Buffer.alloc(0));
  fs.writeFileSync(file, Buffer.concat(chunks));
}

describe('fostral world', () => {
  test.skipIf(!available)('decodes VMC, renders surface and matches hashes', { timeout: 120_000 }, () => {
    fs.mkdirSync(outDir, { recursive: true });
    const read = (name: string) => new Uint8Array(fs.readFileSync(path.join(dataDir, name)));

    const config = parseWorldConfig(fs.readFileSync(path.join(dataDir, 'world.ini'), 'utf8'));
    expect(config.isCompressed).toBe(true);

    // Throws on any per-line byte-boundary mismatch.
    const level = loadVmc(read(`${config.fileName}.vmc`), config);
    expect(level.sizeX).toBe(2048);
    expect(level.sizeY).toBe(16384);
    expect(level.height.length).toBe(2048 * 16384);

    const flood = loadVpr(read(`${config.fileName}.vpr`), config)[0];
    const palette = buildPalette(
      loadPalette(read(config.paletteFile)),
      config.beginColors,
      config.endColors,
    );
    const rgba = palette.rgba;
    const map = new VrtMap(level, renderPrepare(config.beginColors, config.endColors, flood));

    map.lineRenderAll();
    expect(fnv1a(map.color).toString(16)).toBe(LINE_HASH);

    const sample = (x0: number, y0: number, w: number, h: number, step: number) => {
      const out = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) {
        const sy = (y0 + y * step) & (map.sizeY - 1);
        const base = sy * map.sizeX;
        for (let x = 0; x < w; x++) {
          const sx = (x0 + x * step) & (map.sizeX - 1);
          const idx = map.color[base + sx];
          out[(y * w + x) * 3 + 0] = rgba[idx * 4 + 0];
          out[(y * w + x) * 3 + 1] = rgba[idx * 4 + 1];
          out[(y * w + x) * 3 + 2] = rgba[idx * 4 + 2];
        }
      }
      return out;
    };
    const s = 4;
    writePng(
      path.join(outDir, 'overview-line.png'),
      map.sizeX / s,
      map.sizeY / s,
      sample(0, 0, map.sizeX / s, map.sizeY / s, s),
    );

    map.regRenderAll();
    expect(fnv1a(map.color).toString(16)).toBe(REG_COLOR_HASH);
    expect(fnv1a(map.meta).toString(16)).toBe(REG_META_HASH);

    writePng(path.join(outDir, 'overview.png'), map.sizeX / s, map.sizeY / s, sample(0, 0, map.sizeX / s, map.sizeY / s, s));
    writePng(path.join(outDir, 'window.png'), 1024, 768, sample(0, 4096, 1024, 768, 1));
  });
});
