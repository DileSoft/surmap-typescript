// Node validation for the VMC/Huffman decoder and the surface renderers.
//
// Usage:
//   node test/loader.test.mjs [dataDir]
// Default dataDir is the fostral world shipped in the Vangers repo.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  parseWorldConfig,
  loadVmc,
  loadVpr,
  loadPalette,
} from '../dist/src/loader.js';
import { renderPrepare } from '../dist/src/luts.js';
import { VrtMap } from '../dist/src/vmap.js';
import { buildPalette } from '../dist/src/palette.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultData = path.resolve(
  __dirname,
  '../../Vangers/data/thechain/fostral',
);
const dataDir = process.argv[2] || defaultData;
const outDir = path.resolve(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

function readFile(name) {
  return new Uint8Array(fs.readFileSync(path.join(dataDir, name)));
}

console.log(`data dir: ${dataDir}`);
const iniText = fs.readFileSync(path.join(dataDir, 'world.ini'), 'utf8');
const config = parseWorldConfig(iniText);
console.log('config:', {
  mapPowerY: config.mapPowerY,
  geoPower: config.geoPower,
  sectionPower: config.sectionPower,
  isCompressed: config.isCompressed,
  file: config.fileName,
  palette: config.paletteFile,
  begin: config.beginColors,
  end: config.endColors,
});

console.time('decode VMC');
const level = loadVmc(readFile(`${config.fileName}.vmc`), config);
console.timeEnd('decode VMC');
console.log('decoded:', { sizeX: level.sizeX, sizeY: level.sizeY });

// --- sanity stats ----------------------------------------------------------
let doubleCount = 0;
let minH = 255;
let maxH = 0;
const terrainHist = new Array(8).fill(0);
for (let i = 0; i < level.height.length; i++) {
  const h = level.height[i];
  if (h < minH) minH = h;
  if (h > maxH) maxH = h;
}
for (let y = 0; y < level.sizeY; y++) {
  const base = y * level.sizeX;
  for (let x = 0; x < level.sizeX; x++) {
    const m = level.meta[base + x];
    if (m & 0x40) doubleCount++;
    terrainHist[(m & 0x38) >> 3]++;
  }
}
console.log('heights:', { minH, maxH });
console.log('double-level voxels:', doubleCount);
console.log('terrain histogram:', terrainHist);

const flood = loadVpr(readFile(`${config.fileName}.vpr`), config);
console.log('flood sections:', flood.length, 'flood[0]:', flood[0]);

const palFile = loadPalette(readFile(config.paletteFile));
const palette = buildPalette(palFile, config.beginColors, config.endColors);

const luts = renderPrepare(config.beginColors, config.endColors, flood[0]);
const map = new VrtMap(level, luts);

function fnv1a(bytes, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// --- LINE_render -----------------------------------------------------------
console.time('LINE_render all');
map.lineRenderAll();
console.timeEnd('LINE_render all');
console.log('LINE_render hash color:', fnv1a(map.color).toString(16));
{
  const s = 4;
  writePng(
    path.join(outDir, 'overview-line.png'),
    map.sizeX / s,
    map.sizeY / s,
    sampleRgb(0, 0, map.sizeX / s, map.sizeY / s, s),
  );
}

// --- regRender -------------------------------------------------------------
console.time('regRender all');
map.regRenderAll();
console.timeEnd('regRender all');
console.log('regRender  hash color:', fnv1a(map.color).toString(16));
console.log('regRender  hash meta :', fnv1a(map.meta).toString(16));

// --- write previews --------------------------------------------------------
function writePng(file, width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    chunks.push(Buffer.concat([len, t, data, crc]));
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolor
  chunk('IHDR', ihdr);
  chunk('IDAT', idat);
  chunk('IEND', Buffer.alloc(0));
  fs.writeFileSync(file, Buffer.concat(chunks));
}

var crcTable;
function crc32(buf) {
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

function sampleRgb(x0, y0, w, h, step) {
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = (y0 + y * step) & (map.sizeY - 1);
    const base = sy * map.sizeX;
    for (let x = 0; x < w; x++) {
      const sx = (x0 + x * step) & (map.sizeX - 1);
      const idx = map.color[base + sx];
      out[(y * w + x) * 3 + 0] = palette.rgba[idx * 4 + 0];
      out[(y * w + x) * 3 + 1] = palette.rgba[idx * 4 + 1];
      out[(y * w + x) * 3 + 2] = palette.rgba[idx * 4 + 2];
    }
  }
  return out;
}

// Downscaled overview of the whole world (step 4 -> 512 x 4096).
const step = 4;
const ow = map.sizeX / step;
const oh = map.sizeY / step;
writePng(path.join(outDir, 'overview.png'), ow, oh, sampleRgb(0, 0, ow, oh, step));

// 1:1 window.
const winW = 1024;
const winH = 768;
const winY = 4096;
const rawWin = sampleRgb(0, winY, winW, winH, 1);
writePng(path.join(outDir, 'window.png'), winW, winH, rawWin);

console.log(`wrote ${outDir}\\overview.png (${ow}x${oh}) and window.png (${winW}x${winH})`);
