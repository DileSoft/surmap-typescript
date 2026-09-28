/**
 * VMP/VMC/VPR/palette loading, ported from:
 *   src/terra/vmap.cpp   (analyzeINI, fileLoad, YSetup, load, LoadVPR)
 *   src/terra/splay.cpp  (InitSplay / ExpandBuffer)
 * Cross-checked against vange-rs `src/level/mod.rs`.
 */
import { H_SIZE, MAP_POWER_X, TERRAIN_MAX } from './constants';
import { VmcDecoder } from './huffman';
import { iniGet, iniGetInt, parseIntList, parseIni, type Ini } from './ini';

export interface WorldConfig {
  mapPowerX: number;
  mapPowerY: number;
  geoPower: number;
  sectionPower: number;
  minSquarePower: number;
  terrainMax: number;
  isCompressed: boolean;
  fileName: string;
  paletteFile: string;
  beginColors: number[];
  endColors: number[];
  version: string;
}

export interface LevelData {
  sizeX: number;
  sizeY: number;
  height: Uint8Array;
  meta: Uint8Array;
}

export const VMC_TREE_BYTES = VmcDecoder.byteSize;

/** `analyzeINI` + world.ini fields needed for rendering. */
export function parseWorldConfig(iniText: string): WorldConfig {
  const ini: Ini = parseIni(iniText);
  const mapPowerX = iniGetInt(ini, 'Global Parameters', 'Map Power X', 0);
  if (mapPowerX !== MAP_POWER_X) {
    throw new Error(`Incorrect X-Size (Map Power X = ${mapPowerX}, expected ${MAP_POWER_X})`);
  }
  const version = iniGet(ini, 'Storage', 'Version') ?? '';
  if (version !== '1.4') {
    throw new Error(`Incorrect Storage Version "${version}", expected 1.4`);
  }
  const terrainMax = iniGetInt(ini, 'Rendering Parameters', 'Terrain Max', 0);
  if ((!terrainMax && TERRAIN_MAX !== 8) || (terrainMax && terrainMax !== TERRAIN_MAX)) {
    throw new Error(`Incorrect Terrain Max ${terrainMax}`);
  }

  return {
    mapPowerX,
    mapPowerY: iniGetInt(ini, 'Global Parameters', 'Map Power Y', 0),
    geoPower: iniGetInt(ini, 'Global Parameters', 'GeoNet Power', 0),
    sectionPower: iniGetInt(ini, 'Global Parameters', 'Section Size Power', 0),
    minSquarePower: iniGetInt(ini, 'Global Parameters', 'Minimal Square Power', 0),
    terrainMax: terrainMax || TERRAIN_MAX,
    isCompressed: iniGetInt(ini, 'Storage', 'Compressed Format Using', 0) !== 0,
    fileName: iniGet(ini, 'Storage', 'File Name') ?? '',
    paletteFile: iniGet(ini, 'Storage', 'Palette File') ?? '',
    beginColors: parseIntList(iniGet(ini, 'Rendering Parameters', 'Begin Colors'), TERRAIN_MAX),
    endColors: parseIntList(iniGet(ini, 'Rendering Parameters', 'End Colors'), TERRAIN_MAX),
    version,
  };
}

/**
 * Uncompressed VMP layout: for every row, H_SIZE height bytes followed by
 * H_SIZE flag bytes (`load_vmp`).
 */
export function loadVmp(source: Uint8Array, config: WorldConfig): LevelData {
  const sizeX = H_SIZE;
  const sizeY = 1 << config.mapPowerY;
  const total = sizeX * sizeY;
  if (source.length < total * 2) {
    throw new Error(`VMP too small: ${source.length} < ${total * 2}`);
  }
  const height = new Uint8Array(total);
  const meta = new Uint8Array(total);
  let src = 0;
  for (let y = 0; y < sizeY; y++) {
    const base = y * sizeX;
    height.set(source.subarray(src, src + sizeX), base);
    src += sizeX;
    meta.set(source.subarray(src, src + sizeX), base);
    src += sizeX;
  }
  return { sizeX, sizeY, height, meta };
}

/**
 * Compressed VMC layout (`InitSplay` / `load_vmc`):
 *   int32[V_SIZE] offsets, int16[V_SIZE] sizes, two decomp trees, line data.
 */
export function loadVmc(source: Uint8Array, config: WorldConfig): LevelData {
  const sizeX = H_SIZE;
  const sizeY = 1 << config.mapPowerY;
  const total = sizeX * sizeY;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);

  const tableBytes = sizeY * (4 + 2);
  if (source.length < tableBytes + VMC_TREE_BYTES) {
    throw new Error('VMC too small for header');
  }
  // Interleaved records: int32 offset, int16 size (see `load_vmc` / compress.cpp).
  const offsets = new Int32Array(sizeY);
  const sizes = new Int16Array(sizeY);
  for (let i = 0; i < sizeY; i++) {
    offsets[i] = view.getInt32(i * 6, true);
    sizes[i] = view.getInt16(i * 6 + 4, true);
  }

  const decoder = new VmcDecoder(source, tableBytes);
  const height = new Uint8Array(total);
  const meta = new Uint8Array(total);

  for (let y = 0; y < sizeY; y++) {
    const off = offsets[y];
    const size = sizes[y];
    if (off < 0 || size < 0 || off + size > source.length) {
      throw new Error(`VMC line ${y} out of bounds (off=${off}, size=${size})`);
    }
    const end = decoder.expand(source, off, height, meta, y * sizeX);
    if (end !== off + size) {
      throw new Error(
        `VMC line ${y} decode boundary mismatch: consumed ${end - off} of ${size} bytes`,
      );
    }
  }

  return { sizeX, sizeY, height, meta };
}

/** Decodes the flood level table out of a `.vpr` file (`LoadVPR`). */
export function loadVpr(source: Uint8Array, config: WorldConfig): Uint8Array {
  const sizeX = H_SIZE;
  const sizeY = 1 << config.mapPowerY;
  const partMax = sizeY >> config.sectionPower;
  const netSize = (sizeX * sizeY) >> (2 * config.geoPower);

  const offset =
    2 * 4 +
    (1 + 4 + 4) * 4 +
    2 * netSize +
    2 * config.geoPower * 4 +
    2 * partMax * config.geoPower * 4;

  if (source.length < offset + partMax * 4) {
    throw new Error(`VPR too small: ${source.length} < ${offset + partMax * 4}`);
  }
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const flood = new Uint8Array(partMax);
  for (let i = 0; i < partMax; i++) {
    flood[i] = view.getUint32(offset + i * 4, true) & 0xff;
  }
  return flood;
}

/** Reads a 768-byte 6-bit palette (`read_palette`). Values stay 0..63. */
export function loadPalette(source: Uint8Array): Uint8Array {
  if (source.length < 768) throw new Error('Palette file must be at least 768 bytes');
  const pal = new Uint8Array(768);
  pal.set(source.subarray(0, 768));
  return pal;
}
