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
import { VmcDecoder } from '../src/huffman';
import { renderPrepare } from '../src/luts';
import { saveVmc, saveVmp } from '../src/save';
import { loadC3D, projectShape, stampShape, type ShapeOptions } from '../src/shape';
import { VrtMap } from '../src/vmap';
import { applyPaletteCycle, applyWaveCycle, buildPalette } from '../src/palette';

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

describe('palette cycle', () => {
  test('shifts only flagged channels within the terrain range', () => {
    const rgb = new Uint8Array(768).fill(10);
    const begin = [1, 32, 64, 72, 88, 104, 112, 120];
    const end = [31, 63, 71, 87, 103, 111, 119, 127];
    const base = buildPalette(rgb, begin, end);
    const out = applyPaletteCycle(
      base,
      { terrain: 1, speed: 0, ampl: 20, red: 1, green: 0, blue: 0 },
      begin,
      end,
    );
    // index 40 (inside terrain 1 range): red shifted by +20, green/blue intact
    expect(out.rgb[3 * 40 + 0]).toBe(base.rgb[3 * 40 + 0] + 20);
    expect(out.rgb[3 * 40 + 1]).toBe(base.rgb[3 * 40 + 1]);
    expect(out.rgb[3 * 40 + 2]).toBe(base.rgb[3 * 40 + 2]);
    // index 70 (inside terrain 2 range): untouched
    expect(out.rgb[3 * 70 + 0]).toBe(base.rgb[3 * 70 + 0]);
    // saturation at 63
    const base2 = buildPalette(new Uint8Array(768).fill(60), begin, end);
    const out2 = applyPaletteCycle(
      base2,
      { terrain: 1, speed: 0, ampl: 20, red: 1, green: 0, blue: 0 },
      begin,
      end,
    );
    expect(out2.rgb[3 * 40 + 0]).toBe(63);
  });

  test('wave cycle brightens a sliding band in the wave terrain range', () => {
    const rgb = new Uint8Array(768).fill(10);
    const begin = [1, 32, 64, 72, 88, 104, 112, 120];
    const end = [31, 63, 71, 87, 103, 111, 119, 127];
    const base = buildPalette(rgb, begin, end);
    const out = applyWaveCycle(base, 0, begin, end, 0.5);

    let changed = 0;
    let unchanged = 0;
    for (let i = 2; i <= 31; i++) {
      if (out.rgb[3 * i] > base.rgb[3 * i]) changed++;
      else if (out.rgb[3 * i] === base.rgb[3 * i]) unchanged++;
    }
    expect(changed).toBeGreaterThan(0);
    expect(unchanged).toBeGreaterThan(0);
    // outside the wave terrain range (terrain 1 begin) nothing changes
    expect(out.rgb[3 * 32]).toBe(base.rgb[3 * 32]);
  });
});

describe('fostral world', () => {
  test.skipIf(!available)('decodes VMC, renders surface and matches hashes', { timeout: 120_000 }, () => {
    fs.mkdirSync(outDir, { recursive: true });
    const read = (name: string) => new Uint8Array(fs.readFileSync(path.join(dataDir, name)));

    const config = parseWorldConfig(fs.readFileSync(path.join(dataDir, 'world.ini'), 'utf8'));
    expect(config.isCompressed).toBe(true);
    expect(config.dynamicPalette.waveTerrain).toBe(0);
    expect(config.dynamicPalette.cycles.map((c) => c.terrain)).toEqual([5, 4, 6]);
    expect(config.dynamicPalette.cycles.map((c) => c.ampl)).toEqual([32, 8, 32]);
    expect(config.dynamicPalette.cycles.map((c) => c.speed)).toEqual([128, 128, 256]);

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

describe('terrain editing (SURMAP Toolzer)', () => {
  const begin = [1, 32, 64, 72, 88, 104, 112, 120];
  const end = [31, 63, 71, 87, 103, 111, 119, 127];

  function flatMap() {
    const sizeX = 2048;
    const sizeY = 64;
    const height = new Uint8Array(sizeX * sizeY).fill(50);
    const meta = new Uint8Array(sizeX * sizeY);
    for (let i = 0; i < meta.length; i++) meta[i] = 1 << 3; // terrain 1
    return { sizeX, sizeY, height, meta };
  }

  test('raises a flat disk with mountain and removes it with depression', () => {
    const level = flatMap();
    const map = new VrtMap(level, renderPrepare(begin, end, 0));
    const cx = 1000;
    const cy = 32;
    const rad = 40;
    const dh = 20;

    map.deltaZone(cx, cy, rad, 0, dh, 0, 0);
    expect(map.height[cy * level.sizeX + cx]).toBe(70);
    expect(map.height[cy * level.sizeX + cx + rad]).toBe(70); // smth=0 -> flat disk
    expect(map.height[cy * level.sizeX + cx + rad + 3]).toBe(50); // outside untouched

    map.deltaZone(cx, cy, rad, 0, -dh, 0, 0);
    expect(map.height[cy * level.sizeX + cx]).toBe(50);
  });

  test('clamps heights to 0..255 and resetAll restores the relief', () => {
    const level = flatMap();
    const map = new VrtMap(level, renderPrepare(begin, end, 0));

    map.deltaZone(500, 10, 16, 0, 400, 0, 0);
    expect(map.height[10 * level.sizeX + 500]).toBe(255);
    map.deltaZone(500, 10, 16, 0, -400, 0, 0);
    expect(map.height[10 * level.sizeX + 500]).toBe(0);

    map.resetAll();
    expect(map.height[10 * level.sizeX + 500]).toBe(50);
    expect(map.height[10 * level.sizeX + 1]).toBe(50);
  });
});

describe('saving world files', () => {
  const begin = [1, 32, 64, 72, 88, 104, 112, 120];
  const end = [31, 63, 71, 87, 103, 111, 119, 127];

  function makeMap() {
    const sizeX = 2048;
    const sizeY = 16;
    const height = new Uint8Array(sizeX * sizeY);
    const meta = new Uint8Array(sizeX * sizeY);
    for (let y = 0; y < sizeY; y++) {
      for (let x = 0; x < sizeX; x++) {
        const i = y * sizeX + x;
        height[i] = (((x >> 2) ^ (y * 13)) & 0xff) as number;
        meta[i] = ((((x >> 6) & 7) << 3) | ((x + y) & 1 ? 0 : 0x04)) & 0xff;
      }
    }
    return { sizeX, sizeY, height, meta };
  }

  test('saveVmp writes per-row heights then flags', () => {
    const level = makeMap();
    const map = new VrtMap(level, renderPrepare(begin, end, 0));
    map.deltaZone(600, 8, 25, 3, 17, 0, 0);

    const vmp = saveVmp(map);
    expect(vmp.length).toBe(level.sizeX * level.sizeY * 2);
    for (let y = 0; y < level.sizeY; y++) {
      const src = y * level.sizeX;
      const dst = y * level.sizeX * 2;
      expect(Buffer.from(vmp.subarray(dst, dst + level.sizeX))).toEqual(
        Buffer.from(map.height.subarray(src, src + level.sizeX)),
      );
      expect(Buffer.from(vmp.subarray(dst + level.sizeX, dst + 2 * level.sizeX))).toEqual(
        Buffer.from(map.meta.subarray(src, src + level.sizeX)),
      );
    }
  });

  test('saveVmc round-trips through the VMC decoder', () => {
    const level = makeMap();
    const map = new VrtMap(level, renderPrepare(begin, end, 0));
    map.deltaZone(600, 8, 25, 3, 17, 0, 0);
    map.deltaZone(1200, 4, 10, 0, -9, 0, 0);

    const vmc = saveVmc(map);
    const view = new DataView(vmc.buffer, vmc.byteOffset, vmc.byteLength);
    const tableBytes = level.sizeY * 6;
    const decoder = new VmcDecoder(vmc, tableBytes);

    const height = new Uint8Array(level.sizeX * level.sizeY);
    const meta = new Uint8Array(level.sizeX * level.sizeY);
    for (let y = 0; y < level.sizeY; y++) {
      const off = view.getInt32(y * 6, true);
      const size = view.getInt16(y * 6 + 4, true);
      const end2 = decoder.expand(vmc, off, height, meta, y * level.sizeX);
      expect(end2).toBe(off + size);
    }
    expect(Buffer.from(height).equals(Buffer.from(map.height))).toBe(true);
    expect(Buffer.from(meta).equals(Buffer.from(map.meta))).toBe(true);
  });

  test('saveVmc handles a single-symbol (flat) line', () => {
    const sizeX = 2048;
    const sizeY = 4;
    const level = {
      sizeX,
      sizeY,
      height: new Uint8Array(sizeX * sizeY),
      meta: new Uint8Array(sizeX * sizeY),
    };
    const map = new VrtMap(level, renderPrepare(begin, end, 0));
    const vmc = saveVmc(map);

    const view = new DataView(vmc.buffer, vmc.byteOffset, vmc.byteLength);
    const decoder = new VmcDecoder(vmc, sizeY * 6);
    const height = new Uint8Array(sizeX * sizeY);
    const meta = new Uint8Array(sizeX * sizeY);
    for (let y = 0; y < sizeY; y++) {
      const off = view.getInt32(y * 6, true);
      const size = view.getInt16(y * 6 + 4, true);
      expect(decoder.expand(vmc, off, height, meta, y * sizeX)).toBe(off + size);
    }
    expect(height.every((v) => v === 0)).toBe(true);
    expect(meta.every((v) => v === 0)).toBe(true);
  });
});

describe('3D shape insertion', () => {
  const begin = [1, 32, 64, 72, 88, 104, 112, 120];
  const end = [31, 63, 71, 87, 103, 111, 119, 127];
  const opts: ShapeOptions = {
    yaw: 0,
    pitch: 0,
    roll: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    level: 0,
    mode: 0,
    inverse: false,
    side: false,
    noiseLevel: 0,
    noiseAmp: 0,
  };

  /** A minimal C3D (version 8): one triangle with a sloped Z. */
  function synthC3D(): Uint8Array {
    const buf = new ArrayBuffer(512);
    const v = new DataView(buf);
    let o = 0;
    const i32 = (x: number) => {
      v.setInt32(o, x, true);
      o += 4;
    };
    const u32 = (x: number) => {
      v.setUint32(o, x, true);
      o += 4;
    };
    const i8 = (x: number) => {
      v.setInt8(o, x);
      o += 1;
    };
    const u8 = (x: number) => {
      v.setUint8(o, x);
      o += 1;
    };
    const f64 = (x: number) => {
      v.setFloat64(o, x, true);
      o += 8;
    };
    i32(8);
    i32(3);
    i32(1);
    i32(1);
    i32(3);
    i32(10);
    i32(10);
    i32(40); // max
    i32(-10);
    i32(-10);
    i32(0); // min
    i32(0);
    i32(0);
    i32(0); // off
    i32(10); // rmax
    i32(0);
    i32(0);
    i32(0); // phi/psi/tetta
    f64(0);
    f64(0);
    f64(0);
    f64(0); // volume, rcm
    for (let i = 0; i < 9; i++) f64(i % 4 === 0 ? 1 : 0);
    const verts = [
      [0, 0, 0],
      [20, 0, 0],
      [0, 20, 40],
    ];
    for (const [x, y, z] of verts) {
      i32(x);
      i32(y);
      i32(z);
      i8(x);
      i8(y);
      i8(z);
      i32(0);
    }
    i8(0);
    i8(0);
    i8(127);
    u8(0);
    i32(0); // one normal
    i32(3);
    i32(0);
    u32(1);
    u32(0);
    i8(0);
    i8(0);
    i8(127);
    u8(0);
    i8(0);
    i8(0);
    i8(0);
    for (const vi of [0, 1, 2]) {
      i32(vi);
      i32(0);
    }
    return new Uint8Array(buf, 0, o);
  }

  function flatMap() {
    const sizeX = 2048;
    const sizeY = 64;
    const height = new Uint8Array(sizeX * sizeY).fill(50);
    const meta = new Uint8Array(sizeX * sizeY);
    for (let i = 0; i < meta.length; i++) meta[i] = 1 << 3;
    return { sizeX, sizeY, height, meta };
  }

  test('loads a synthetic C3D and projects a non-empty footprint', () => {
    const model = loadC3D(synthC3D());
    expect(model.numVert).toBe(3);
    expect(model.numPoly).toBe(1);
    expect(Array.from(model.polys[0])).toEqual([0, 1, 2]);

    const proj = projectShape(model, opts, 0, 0);
    expect(proj.size).toBeGreaterThan(0);
    expect(proj.dim).toBeGreaterThanOrEqual(proj.size);
    const touched = proj.upper.reduce((n, v) => n + (v ? 1 : 0), 0);
    expect(touched).toBeGreaterThan(0);
    // Z grows with the model's Z (flipped once by diag(1,-1,-1) then re-flipped)
    expect(Math.max(...proj.upper) - Math.min(...proj.upper.filter((v) => v))).toBeGreaterThan(0);
  });

  test('stampShape writes the projection into the terrain', () => {
    const level = flatMap();
    const map = new VrtMap(level, renderPrepare(begin, end, 0));
    const model = loadC3D(synthC3D());

    const region = stampShape(map, model, opts, 300, 20);
    expect(region.hiX - region.lowX + 1).toBe(projectShape(model, opts, 300, 20).size);

    let changed = 0;
    for (let y = 0; y < level.sizeY; y++) {
      for (let x = 0; x < level.sizeX; x++) {
        if (map.height[y * level.sizeX + x] !== 50) changed++;
      }
    }
    expect(changed).toBeGreaterThan(0);

    // mode 0 replaces heights with the projected Z (1..255)
    let maxH = 0;
    for (let i = 0; i < map.height.length; i++) if (map.height[i] > maxH) maxH = map.height[i];
    expect(maxH).toBeLessThanOrEqual(255);
  });

  const realC3D = path.resolve(
    __dirname,
    '../../Vangers/vangers/bin/shape3d/u1.c3d',
  );
  test.skipIf(!fs.existsSync(realC3D))('parses the real u1.c3d model', () => {
    const model = loadC3D(new Uint8Array(fs.readFileSync(realC3D)));
    expect(model.numVert).toBe(363);
    expect(model.numPoly).toBe(646);
    const proj = projectShape(model, opts, 0, 0);
    const touched = proj.upper.reduce((n, v) => n + (v ? 1 : 0), 0);
    expect(touched).toBeGreaterThan(0);
  });
});
