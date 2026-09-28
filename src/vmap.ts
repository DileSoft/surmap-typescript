/**
 * In-memory Vangers terrain + surface renderers.
 *
 * Ported 1:1 from:
 *   src/terra/land.cpp      -> LINE_render
 *   src/terra/siderend.cpp  -> regRender (PreStage / MainStage / post pass)
 *
 * Note: the original stores each row as a single 2*H_SIZE block (heights then
 * flags). Here heights and flags live in separate arrays; all accesses are made
 * with the same modular `x & (H_SIZE-1)` arithmetic the original uses via
 * XCYCL/YCYCL.
 */
import {
  DELTA_MASK,
  DELTA_SHIFT,
  DOUBLE_LEVEL,
  H_CORRECTION,
  H_SIZE,
  MAX_ALT,
  OBJSHADOW,
  POSPOWER,
  SHADOWDEEP,
  SHADOWHEIGHT,
  SHADOW_MASK,
  SS_WIDTH,
  TERRAIN_MASK,
  TERRAIN_OFFSET,
  xcycl,
} from './constants';
import { deltaZone, type EditableMap } from './edit';
import type { LevelData } from './loader';
import type { Luts } from './luts';

const SHADOW_PARENT_SIZE = 4 * H_SIZE; // RenderPrepare: new uchar[4 * map_size_x]

interface StageResult {
  hC: number;
  x: number;
  grid: number;
  maxAlt: number;
}

export class VrtMap {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly clipMaskY: number;

  readonly height: Uint8Array;
  /** Flag bytes. `regRender` rewrites the SHADOW/OBJSHADOW bits here. */
  readonly meta: Uint8Array;
  /** Snapshot of `meta` as loaded, so `regRender` edits can be undone. */
  private readonly metaOriginal: Uint8Array;
  /** Snapshot of `height` as loaded, so terrain edits can be undone. */
  private readonly heightOriginal: Uint8Array;
  /** Per-voxel surface palette index (`lineTcolor`). */
  readonly color: Uint8Array;

  readonly luts: Luts;
  private readonly sp: Uint8Array;

  constructor(level: LevelData, luts: Luts) {
    this.sizeX = level.sizeX;
    this.sizeY = level.sizeY;
    this.clipMaskY = level.sizeY - 1;
    this.height = level.height;
    this.meta = level.meta;
    this.metaOriginal = level.meta.slice();
    this.heightOriginal = level.height.slice();
    this.color = new Uint8Array(level.sizeX * level.sizeY);
    this.luts = luts;
    this.sp = new Uint8Array(SHADOW_PARENT_SIZE);
  }

  /**
   * Restores the render-written flag bits (SHADOW/OBJSHADOW) to their as-loaded
   * state. Terrain / double-level / delta edits done by the editor are kept.
   */
  resetMeta(): void {
    const { meta, metaOriginal } = this;
    for (let i = 0; i < meta.length; i++) {
      meta[i] = (meta[i] & ~(SHADOW_MASK | OBJSHADOW)) | (metaOriginal[i] & (SHADOW_MASK | OBJSHADOW));
    }
  }

  /** Restores the heightmap to the as-loaded state (undoes all terrain edits). */
  resetHeights(): void {
    this.height.set(this.heightOriginal);
  }

  /** Restores both heightmap and flags to the as-loaded state. */
  resetAll(): void {
    this.resetHeights();
    this.meta.set(this.metaOriginal);
  }

  // ---------------------------------------------------------------------------
  // land.cpp : editing primitives (SURMAP build)
  // ---------------------------------------------------------------------------

  /** `GET_UP_ALT`: height shown on top at `index` (column `x`). */
  getUpAlt(index: number, x: number): number {
    const { height, meta } = this;
    if (meta[index] & DOUBLE_LEVEL) {
      const row = index - x;
      return x & 1 ? height[index] : height[row + xcycl(x + 1)];
    }
    return height[index];
  }

  /** `GET_DOWN_ALT`: height shown underneath at `index` (column `x`). */
  getDownAlt(index: number, x: number): number {
    const { height, meta } = this;
    if (meta[index] & DOUBLE_LEVEL && x & 1) {
      return height[index - x + xcycl(x - 1)];
    }
    return height[index];
  }

  /**
   * Port of `pixSet` (src/terra/land.cpp) for the game/SURMAP height path:
   * adds `delta` to the voxel height, handling double-level columns and
   * clamping to 0..255 (`LandBounded`). Terrain is left untouched (`surf = 0`).
   */
  pixSet(x: number, y: number, delta: number): void {
    if (!delta) return;
    const { height, meta } = this;
    const base = y * H_SIZE + x;
    let h = this.getUpAlt(base, x);

    if (meta[base] & DOUBLE_LEVEL) {
      if (x & 1) {
        h += delta;
        const width =
          ((((meta[base - 1] & DELTA_MASK) << 2) + (meta[base] & DELTA_MASK) + 1) << DELTA_SHIFT);
        if (height[base - 1] + width >= h) {
          meta[base] &= ~DOUBLE_LEVEL;
          meta[base - 1] &= ~DOUBLE_LEVEL;
          meta[base] = (meta[base] & ~TERRAIN_MASK) | (meta[base - 1] & TERRAIN_MASK);
          const xx = xcycl(x + 1);
          h = (height[base - 1] + this.getDownAlt(base + (xx - x), xx)) >> 1;
          meta[base] &= ~DELTA_MASK;
          meta[base - 1] &= ~DELTA_MASK;
        }
      } else {
        return;
      }
    } else {
      h += delta;
    }

    if (h < 0) h = 0;
    else if (h > 255) h = 255;
    height[base] = h;
  }

  /** Port of `deltaZone` (the SURMAP Toolzer): a round hill/pit. */
  deltaZone(x: number, y: number, rad: number, smth: number, dh: number, smode = 0, eql = 0): void {
    deltaZone(this as EditableMap, x, y, rad, smth, dh, smode, eql);
  }

  // ---------------------------------------------------------------------------
  // land.cpp : LINE_render
  // ---------------------------------------------------------------------------

  /** Computes `color` for a whole row from heights/flags. */
  lineRender(y: number): void {
    const base = y * H_SIZE;
    const { height, meta, color, luts } = this;
    const { lightCLR, palCLR, FloodLEVEL } = luts;

    let x = 0;
    while (x < H_SIZE) {
      const f = meta[base + x];
      if (f & DOUBLE_LEVEL) {
        // The double-level voxel occupies columns x and x+1; both get the same
        // colour computed from the *upper* height (matches `*pa` after `pa++`).
        const type = (meta[base + x + 1] & TERRAIN_MASK) >> TERRAIN_OFFSET;
        const h = height[base + x + 1];
        const lxVal = h;
        const rxVal = height[base + xcycl(x + 3)];
        const shadow = (meta[base + x + 1] & SHADOW_MASK) !== 0;
        const v = shade(palCLR[type], lightCLR[type], lxVal, rxVal, h, shadow);
        color[base + x] = v;
        color[base + x + 1] = v;
        x += 2;
      } else {
        // First pixel at x.
        {
          const type = (meta[base + x] & TERRAIN_MASK) >> TERRAIN_OFFSET;
          const lxVal = height[base + xcycl(x - 1)];
          const rxVal = height[base + xcycl(x + 1)];
          const h = height[base + x];
          const shadow = (meta[base + x] & SHADOW_MASK) !== 0;
          color[base + x] = shade(palCLR[type], lightCLR[type], lxVal, rxVal, h, shadow);
        }
        // Second pixel at x+1.
        {
          const type = (meta[base + x + 1] & TERRAIN_MASK) >> TERRAIN_OFFSET;
          const lxVal = height[base + x];
          const rxVal = height[base + xcycl(x + 2)];
          const h = height[base + x + 1];
          const shadow = (meta[base + x + 1] & SHADOW_MASK) !== 0;
          color[base + x + 1] = shade(
            palCLR[type],
            lightCLR[type],
            lxVal,
            rxVal,
            h,
            shadow,
          );
        }
        x += 2;
      }
    }
  }

  /** Renders the whole surface with LINE_render. */
  lineRenderAll(): void {
    for (let y = 0; y < this.sizeY; y++) this.lineRender(y);
  }

  // ---------------------------------------------------------------------------
  // siderend.cpp : regRender
  // ---------------------------------------------------------------------------

  /**
   * Renders (and updates shadow bits for) an inclusive region. Mirrors the
   * original call convention: `regRender(LowX, LowY, HiX, HiY)`.
   */
  regRender(lowX: number, lowY: number, hiX: number, hiY: number): void {
    lowX = xcycl(lowX);
    hiX = xcycl(hiX);
    lowY = lowY & this.clipMaskY;
    hiY = hiY & this.clipMaskY;

    lowX &= ~1;
    hiX |= 1;

    const sizeY = lowY === hiY ? this.sizeY : (hiY - lowY) & this.clipMaskY;
    const dx = xcycl(hiX - lowX);
    const sizeX = dx === 0 ? H_SIZE : dx;

    const { sp } = this;
    for (let j = 0; j < sizeY; j++) {
      const y = (j + lowY) & this.clipMaskY;
      const base = y * H_SIZE;

      sp.fill(0, 0, ((sizeX * SHADOWDEEP) >> POSPOWER) + 4 * MAX_ALT);

      let hC = MAX_ALT;
      let lastStep = (H_SIZE - 1 - hiX) * SHADOWDEEP;
      lastStep -= ((lastStep >> POSPOWER) - MAX_ALT) << POSPOWER;

      const pre = this.preStage(base, hiX, lastStep, hC, MAX_ALT);
      hC = pre.hC;

      const main = this.mainStage(base, sizeX, hC, hiX, MAX_ALT + MAX_ALT, 0);
      this.postStage(base, main.x, main.hC, main.grid, main.maxAlt);
    }
  }

  /** Renders every row of the surface with regRender (full width, all rows). */
  regRenderAll(): void {
    for (let y = 0; y < this.sizeY; y++) {
      this.regRender(0, y, H_SIZE - 1, y + 1);
    }
  }

  // --- siderend.cpp : PreStage ----------------------------------------------
  private preStage(
    base: number,
    hiX: number,
    lastStepIn: number,
    hCIn: number,
    pmaskOff: number,
  ): { hC: number } {
    const { height, meta, sp } = this;
    let lastStep = lastStepIn;
    let hC = hCIn;
    let maskShift = lastStep >> POSPOWER;
    let x = xcycl(hiX + 1);

    while (hC - maskShift < MAX_ALT) {
      if (meta[base + x] & DOUBLE_LEVEL) {
        const dh = height[base + x] + maskShift;
        lastStep -= SHADOWDEEP;
        maskShift = lastStep >> POSPOWER;
        x = xcycl(x + 1);
        const h = height[base + x] + maskShift;
        if (hC < dh) {
          memset(sp, pmaskOff + hC, dh - hC);
          hC = dh;
        }
        memset(sp, pmaskOff + h - SS_WIDTH, SS_WIDTH + 1);
        x = xcycl(x + 1);
      } else {
        let h = height[base + x] + maskShift;
        if (hC < h) {
          memset(sp, pmaskOff + hC, h - hC);
          hC = h;
        }
        lastStep -= SHADOWDEEP;
        maskShift = lastStep >> POSPOWER;
        x = xcycl(x + 1);
        h = height[base + x] + maskShift;
        if (hC < h) {
          memset(sp, pmaskOff + hC, h - hC);
          hC = h;
        }
        x = xcycl(x + 1);
      }
      lastStep -= SHADOWDEEP;
      maskShift = lastStep >> POSPOWER;
      x = xcycl(x + 2);
    }

    return { hC: hC - MAX_ALT };
  }

  // --- siderend.cpp : MainStage ---------------------------------------------
  private mainStage(
    base: number,
    sizeX: number,
    hCIn: number,
    xIn: number,
    gridIn: number,
    maxAltIn: number,
  ): StageResult {
    const { height, meta, color, sp, luts } = this;
    const { lightCLR, palCLR, FloodLEVEL } = luts;

    let hC = hCIn;
    let x = xIn;
    let grid = gridIn;
    let maxAlt = maxAltIn;
    let typeC = 0xff;
    let pal = palCLR[0];
    let light = lightCLR[0];

    for (let i = 0; i < sizeX; i += 2) {
      if (meta[base + x] & DOUBLE_LEVEL) {
        const lxVal = height[base + x];
        const rxVal = height[base + xcycl(x + 2)];
        const h = height[base + x];
        const dh = height[base + xcycl(x - 1)];
        const type = (meta[base + x] & TERRAIN_MASK) >> TERRAIN_OFFSET;
        const level = type ? h : FloodLEVEL;
        if (type !== typeC) {
          typeC = type;
          pal = palCLR[type];
          light = lightCLR[type];
        }

        grid += 3;
        hC -= 3;
        maxAlt -= 3;

        const xi = x;
        const xp = xcycl(x - 1);
        if (sp[grid + level]) {
          meta[base + xi] |= SHADOW_MASK;
          meta[base + xp] |= SHADOW_MASK;
          const v = pal[
            256 + ((light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)) >> 1)
          ];
          color[base + xi] = v;
          color[base + xp] = v;
        } else {
          meta[base + xi] &= ~SHADOW_MASK;
          meta[base + xp] &= ~SHADOW_MASK;
          const v =
            pal[256 + light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)];
          color[base + xi] = v;
          color[base + xp] = v;
        }
        if (sp[grid + SHADOWHEIGHT + level]) {
          meta[base + xi] |= OBJSHADOW;
          meta[base + xp] |= OBJSHADOW;
        } else {
          meta[base + xi] &= ~OBJSHADOW;
          meta[base + xp] &= ~OBJSHADOW;
        }

        if (dh > hC) {
          memset(sp, grid + hC, dh - hC);
          hC = dh;
        }
        memset(sp, grid + h - SS_WIDTH, SS_WIDTH + 1);
        if (h > maxAlt) maxAlt = h;
      } else {
        let lxVal = height[base + xcycl(x - 1)];
        let rxVal = height[base + xcycl(x + 1)];
        let h = height[base + x];
        let type = (meta[base + x] & TERRAIN_MASK) >> TERRAIN_OFFSET;
        let level = type ? h : FloodLEVEL;

        grid += 1;
        hC -= 1;
        maxAlt -= 1;
        if (type !== typeC) {
          typeC = type;
          pal = palCLR[type];
          light = lightCLR[type];
        }

        const xi = x;
        if (sp[grid + level]) {
          meta[base + xi] |= SHADOW_MASK;
          color[base + xi] =
            pal[256 + ((light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)) >> 1)];
        } else {
          meta[base + xi] &= ~SHADOW_MASK;
          color[base + xi] =
            pal[256 + light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)];
        }
        if (sp[grid + SHADOWHEIGHT + level]) meta[base + xi] |= OBJSHADOW;
        else meta[base + xi] &= ~OBJSHADOW;

        if (h > hC) {
          memset(sp, grid + hC, h - hC);
          hC = h;
        }
        if (h > maxAlt) maxAlt = h;

        // Second pixel (pointer decrement; `x` itself does not change).
        const xp = xcycl(x - 1);
        rxVal = h;
        h = lxVal;
        lxVal = height[base + xcycl(x - 2)];
        grid += 2;
        hC -= 2;
        maxAlt -= 2;
        type = (meta[base + xp] & TERRAIN_MASK) >> TERRAIN_OFFSET;
        level = type ? h : FloodLEVEL;
        if (type !== typeC) {
          typeC = type;
          pal = palCLR[type];
          light = lightCLR[type];
        }

        if (sp[grid + level]) {
          meta[base + xp] |= SHADOW_MASK;
          color[base + xp] =
            pal[256 + ((light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)) >> 1)];
        } else {
          meta[base + xp] &= ~SHADOW_MASK;
          color[base + xp] =
            pal[256 + light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)];
        }
        if (sp[grid + SHADOWHEIGHT + level]) meta[base + xp] |= OBJSHADOW;
        else meta[base + xp] &= ~OBJSHADOW;

        if (h > hC) {
          memset(sp, grid + hC, h - hC);
          hC = h;
        }
        if (h > maxAlt) maxAlt = h;
      }

      if (x === 1) {
        x = H_SIZE - 1;
      } else {
        x = xcycl(x - 2);
      }
    }

    return { hC, x, grid, maxAlt };
  }

  // --- siderend.cpp : post pass ---------------------------------------------
  private postStage(
    base: number,
    xIn: number,
    hCIn: number,
    gridIn: number,
    maxAltIn: number,
  ): void {
    const { height, meta, color, sp, luts } = this;
    const { lightCLR, palCLR, FloodLEVEL } = luts;

    let x = xIn | 1;
    let hC = hCIn;
    let grid = gridIn;
    let maxAlt = maxAltIn;
    let typeC = 0xff;
    let pal = palCLR[0];
    let light = lightCLR[0];

    let maxPossibleAlt = MAX_ALT;
    let bNeedScan = 1;
    while (bNeedScan && maxPossibleAlt >= 0) {
      bNeedScan = 0;
      if (meta[base + x] & DOUBLE_LEVEL) {
        const lxVal = height[base + x];
        const rxVal = height[base + xcycl(x + 2)];
        const h = height[base + x];
        const dh = height[base + xcycl(x - 1)];
        const type = (meta[base + x] & TERRAIN_MASK) >> TERRAIN_OFFSET;
        const level = type ? h : FloodLEVEL;
        if (type !== typeC) {
          typeC = type;
          pal = palCLR[type];
          light = lightCLR[type];
        }

        grid += 3;
        hC -= 3;
        maxAlt -= 3;
        maxPossibleAlt -= 3;
        if (dh < maxAlt || meta[base + x] & SHADOW_MASK) bNeedScan = 1;

        const xi = x;
        const xp = xcycl(x - 1);
        if (sp[grid + level]) {
          meta[base + xi] |= SHADOW_MASK;
          meta[base + xp] |= SHADOW_MASK;
          const v = pal[
            256 + ((light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)) >> 1)
          ];
          color[base + xi] = v;
          color[base + xp] = v;
        } else {
          meta[base + xi] &= ~SHADOW_MASK;
          meta[base + xp] &= ~SHADOW_MASK;
          const v =
            pal[256 + light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)];
          color[base + xi] = v;
          color[base + xp] = v;
        }
        if (sp[grid + SHADOWHEIGHT + level]) {
          meta[base + xi] |= OBJSHADOW;
          meta[base + xp] |= OBJSHADOW;
        } else {
          meta[base + xi] &= ~OBJSHADOW;
          meta[base + xp] &= ~OBJSHADOW;
        }

        if (meta[base + xp] & SHADOW_MASK) bNeedScan = 1;
        if (dh > hC) {
          memset(sp, grid + hC, dh - hC);
          hC = dh;
        }
        memset(sp, grid + h - SS_WIDTH, SS_WIDTH + 1);
      } else {
        let lxVal = height[base + xcycl(x - 1)];
        let rxVal = height[base + xcycl(x + 1)];
        let h = height[base + x];
        let type = (meta[base + x] & TERRAIN_MASK) >> TERRAIN_OFFSET;
        let level = type ? h : FloodLEVEL;

        grid += 1;
        hC -= 1;
        maxAlt -= 1;
        maxPossibleAlt -= 1;
        if (type !== typeC) {
          typeC = type;
          pal = palCLR[type];
          light = lightCLR[type];
        }

        if (h <= maxAlt || meta[base + x] & SHADOW_MASK) bNeedScan = 1;
        const xi = x;
        if (sp[grid + level]) {
          meta[base + xi] |= SHADOW_MASK;
          color[base + xi] =
            pal[256 + ((light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)) >> 1)];
        } else {
          meta[base + xi] &= ~SHADOW_MASK;
          color[base + xi] =
            pal[256 + light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)];
        }
        if (sp[grid + SHADOWHEIGHT + level]) meta[base + xi] |= OBJSHADOW;
        else meta[base + xi] &= ~OBJSHADOW;

        if (h > hC) {
          memset(sp, grid + hC, h - hC);
          hC = h;
        }

        const xp = xcycl(x - 1);
        rxVal = h;
        h = lxVal;
        lxVal = height[base + xcycl(x - 2)];
        grid += 2;
        hC -= 2;
        maxAlt -= 2;
        maxPossibleAlt -= 2;
        type = (meta[base + xp] & TERRAIN_MASK) >> TERRAIN_OFFSET;
        level = type ? h : FloodLEVEL;
        if (type !== typeC) {
          typeC = type;
          pal = palCLR[type];
          light = lightCLR[type];
        }

        if (h <= maxAlt || meta[base + xp] & SHADOW_MASK) bNeedScan = 1;
        if (sp[grid + level]) {
          meta[base + xp] |= SHADOW_MASK;
          color[base + xp] =
            pal[256 + ((light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)) >> 1)];
        } else {
          meta[base + xp] &= ~SHADOW_MASK;
          color[base + xp] =
            pal[256 + light[255 - (lxVal - rxVal)] - ((255 - h) >> H_CORRECTION)];
        }
        if (sp[grid + SHADOWHEIGHT + level]) meta[base + xp] |= OBJSHADOW;
        else meta[base + xp] &= ~OBJSHADOW;

        if (h > hC) {
          memset(sp, grid + hC, h - hC);
          hC = h;
        }
      }

      if (x === 1) {
        x = H_SIZE - 1;
      } else {
        x = xcycl(x - 2);
      }
    }
  }
}

/** `palCLR[type][256 + light - depth]` with the shadow half-brightness rule. */
function shade(
  pal: Uint8Array,
  light: Uint8Array,
  lxVal: number,
  rxVal: number,
  h: number,
  shadow: boolean,
): number {
  const l = light[255 - (lxVal - rxVal)];
  const depth = (255 - h) >> H_CORRECTION;
  if (shadow) return pal[256 + ((l - depth) >> 1)];
  return pal[256 + l - depth];
}

function memset(arr: Uint8Array, start: number, len: number): void {
  if (len > 0) arr.fill(1, start, start + len);
}
