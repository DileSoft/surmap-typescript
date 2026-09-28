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
 * Applies one `Dynamic Palette` record to a base palette (the original
 * `pal_iter2` colour shift, taken at peak amplitude `sin = 1` and without the
 * per-frame time step). Only the channels flagged in the record are shifted,
 * within the record's terrain colour range, clamped to the 0..63 range.
 */
export function applyPaletteCycle(
  base: Palette,
  cycle: PaletteCycle,
  beginColors: number[],
  endColors: number[],
): Palette {
  const rgb = base.rgb.slice();
  const beg = beginColors[cycle.terrain];
  const end = endColors[cycle.terrain];
  const add = cycle.ampl;
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
