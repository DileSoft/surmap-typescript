/**
 * Palette handling. The renderers produce 8-bit *palette indices*; this module
 * turns them into RGBA for canvas.
 *
 * `PalettePrepare` (src/road.cpp) does, for the terrain-relevant range:
 *   - index 0 -> black
 *   - every BeginColor entry is halved
 *   - the object palette (> ENDCOLOR[last]) is replaced (optional here)
 * and finally `XGR_SetPal` scales the 6-bit values by 4 (vange-rs does `<< 2`).
 */
import { TERRAIN_MAX } from './constants';

export interface Palette {
  /** 768 bytes of 6-bit RGB (corrected, not yet scaled). */
  rgb: Uint8Array;
  /** 256 * 4 RGBA bytes ready for ImageData. */
  rgba: Uint8ClampedArray;
}

/** One record of the world's `Dynamic Palette` section. */
export interface PaletteCycle {
  terrain: number;
  speed: number;
  ampl: number;
  red: number;
  green: number;
  blue: number;
}

const PIx2 = 1 << 12; // 4096 angle units
const SIN_UNIT = 1 << 16; // UNIT (0x10000)

/** `SI[i] = round(UNIT * sin(i / PIx2 * 2pi))` — the game's sine table. */
function sine(offset: number): number {
  return Math.round(SIN_UNIT * Math.sin((offset / PIx2) * Math.PI * 2));
}

/**
 * `pal_iter0`/`pal_iter1`: a bright band that slides across the palette range of
 * the world's `Wave Terrain` (for fostral this is water, terrain 0). The band
 * shape is fixed; `phase01` (0..1) selects its position within the cycle.
 * Applied statically, without the per-frame time step.
 */
export function applyWaveCycle(
  base: Palette,
  waveTerrain: number,
  beginColors: number[],
  endColors: number[],
  phase01: number,
): Palette {
  if (waveTerrain < 0 || waveTerrain >= 8) return base;
  const rgb = base.rgb.slice();
  const beg = beginColors[waveTerrain];
  const sz = endColors[waveTerrain] - beg;
  if (sz <= 0) return { rgb, rgba: toRgba(rgb) };

  // pal_iter1 waveform (the one that survives pal_iter0, which writes the same range).
  const data = [1, 3, 5, 7, 10, 8, 6, 4, 2, 1];
  const dsize = data.length;
  const off = Math.round(-dsize + phase01 * (sz + dsize - 1));

  let p = beg + 1 + (off > 0 ? off : 0);
  for (let i = 0; i < dsize; i++) {
    if (off + i >= 0 && off + i < sz) {
      for (let c = 0; c < 3; c++) {
        const v = rgb[3 * p + c] + data[i];
        rgb[3 * p + c] = v > 63 ? 63 : v;
      }
      p++;
    }
  }
  return { rgb, rgba: toRgba(rgb) };
}

export function buildPalette(
  paletteFile: Uint8Array,
  beginColors: number[],
  endColors: number[],
  objectsPal?: Uint8Array,
): Palette {
  const rgb = new Uint8Array(768);
  rgb.set(paletteFile.subarray(0, 768));

  // optional objects.pal for indices beyond the last terrain colour
  if (objectsPal) {
    const start = endColors[TERRAIN_MAX - 1] + 1;
    const count = 768 - 3 * start;
    if (count > 0 && objectsPal.length >= 3 * start + count) {
      rgb.set(objectsPal.subarray(3 * start, 3 * start + count), 3 * start);
    }
  }

  rgb[0] = rgb[1] = rgb[2] = 0;
  for (let i = 0; i < TERRAIN_MAX; i++) {
    const idx = 3 * beginColors[i];
    rgb[idx] >>= 1;
    rgb[idx + 1] >>= 1;
    rgb[idx + 2] >>= 1;
  }

  // 224..239 grayscale ramp (PalettePrepare)
  for (let i = 0; i < 16; i++) {
    rgb[3 * (224 + i) + 0] = rgb[3 * (224 + i) + 1] = rgb[3 * (224 + i) + 2] = i * 4;
  }

  return { rgb, rgba: toRgba(rgb) };
}

/**
 * Applies one `Dynamic Palette` record to a base palette — the original
 * `pal_iter2` colour shift `add = ampl * sin(offset) / UNIT`, without the
 * per-frame time step. `phase01` (0..1) selects the cycle position; 0.25 is the
 * positive peak (+ampl), 0.75 the negative one. Only the channels flagged in the
 * record are shifted, within its terrain colour range, clamped to 0..63.
 */
export function applyPaletteCycle(
  base: Palette,
  cycle: PaletteCycle,
  beginColors: number[],
  endColors: number[],
  phase01 = 0.25,
): Palette {
  const rgb = base.rgb.slice();
  const offset = Math.round(phase01 * (PIx2 - 1));
  const add = Math.trunc((cycle.ampl * sine(offset)) / SIN_UNIT);
  const beg = beginColors[cycle.terrain];
  const end = endColors[cycle.terrain];
  for (let i = beg; i <= end; i++) {
    if (cycle.red) rgb[3 * i + 0] = clamp6(rgb[3 * i + 0] + add);
    if (cycle.green) rgb[3 * i + 1] = clamp6(rgb[3 * i + 1] + add);
    if (cycle.blue) rgb[3 * i + 2] = clamp6(rgb[3 * i + 2] + add);
  }
  return { rgb, rgba: toRgba(rgb) };
}

function clamp6(v: number): number {
  return v < 0 ? 0 : v > 63 ? 63 : v;
}

/** XGR_SetPal: 6-bit -> 8-bit, expands to an RGBA LUT. */
export function toRgba(rgb: Uint8Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    rgba[i * 4 + 0] = rgb[i * 3 + 0] << 2;
    rgba[i * 4 + 1] = rgb[i * 3 + 1] << 2;
    rgba[i * 4 + 2] = rgb[i * 3 + 2] << 2;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
