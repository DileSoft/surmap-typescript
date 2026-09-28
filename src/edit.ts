/**
 * Terrain editing primitives, ported from the SURMAP editor:
 *   src/terra/land.cpp  -> landPrepare() (radius tables) + deltaZone()
 *
 * `deltaZone` is the "Toolzer": it raises (dh > 0 -> mountain) or lowers
 * (dh < 0 -> depression) a round zone, with a smooth falloff near the rim.
 * Every voxel is written through `pixSet` (see vmap.ts), which mirrors the
 * original height/double-level handling.
 */
import { H_SIZE, MAX_RADIUS } from './constants';

/** Minimal surface the editor needs from a map. */
export interface EditableMap {
  sizeX: number;
  sizeY: number;
  /** Writes a height delta (and optionally a material) to the current layer. */
  pixSet(x: number, y: number, delta: number, material?: number): void;
  /** Current layer altitude at an absolute index (`GET_UP_ALT`/`GET_DOWN_ALT`). */
  getAlt(index: number, x: number): number;
}

/**
 * Offset tables from landPrepare(): for every integer radius `r` (0..maxRadius)
 * the list of (dx, dy) offsets whose truncated distance from the centre equals
 * `r`. Used by deltaZone to paint concentric rings.
 */
export class RadTables {
  readonly maxRad: Int32Array;
  private readonly xRad: Int16Array[];
  private readonly yRad: Int16Array[];

  constructor(readonly maxRadius: number = MAX_RADIUS) {
    const side = 2 * maxRadius + 1;
    const rad = new Int16Array(side * side);
    const maxRad = new Int32Array(maxRadius + 1);
    let total = 0;
    let p = 0;
    for (let j = -maxRadius; j <= maxRadius; j++) {
      for (let i = -maxRadius; i <= maxRadius; i++, p++) {
        const r = Math.trunc(Math.sqrt(i * i + j * j));
        if (r > maxRadius) rad[p] = -1;
        else {
          rad[p] = r;
          maxRad[r]++;
          total++;
        }
      }
    }

    const xHeap = new Int16Array(total);
    const yHeap = new Int16Array(total);
    this.xRad = new Array(maxRadius + 1);
    this.yRad = new Array(maxRadius + 1);
    let off = 0;
    for (let ind = 0; ind <= maxRadius; ind++) {
      let r = 0;
      p = 0;
      for (let j = -maxRadius; j <= maxRadius; j++) {
        for (let i = -maxRadius; i <= maxRadius; i++, p++) {
          if (rad[p] === ind) {
            xHeap[off + r] = i;
            yHeap[off + r] = j;
            r++;
          }
        }
      }
      this.xRad[ind] = xHeap.subarray(off, off + maxRad[ind]);
      this.yRad[ind] = yHeap.subarray(off, off + maxRad[ind]);
      off += maxRad[ind];
    }
    this.maxRad = maxRad;
  }

  ringX(r: number): Int16Array {
    return this.xRad[r];
  }

  ringY(r: number): Int16Array {
    return this.yRad[r];
  }
}

let radTables: RadTables | null = null;

/** Lazily built, shared radius tables (the C++ build keeps one global set). */
export function getRadTables(): RadTables {
  if (!radTables) radTables = new RadTables(MAX_RADIUS);
  return radTables;
}

let locp = 0;

/**
 * Port of `deltaZone` from src/terra/land.cpp (the _SURMAP_ Toolzer).
 *
 * @param x,y    centre voxel
 * @param rad    radius (1..MAX_RADIUS)
 * @param smth   smooth zone 0..10 (0 = flat disk, 10 = mostly falloff)
 * @param dh     height delta per click (>0 mountain, <0 depression, 0 = smooth)
 * @param smode  rim distribution: 0 = even, 1 = random, 2 = rotating
 * @param eql    smoothing threshold (used when dh == 0)
 * @param material  material (`CurrentTerrain`) written to touched voxels, or
 *                  `TERRAIN_KEEP`/negative to leave the material unchanged.
 */
export function deltaZone(
  map: EditableMap,
  x: number,
  y: number,
  rad: number,
  smth: number,
  dh: number,
  smode: number,
  eql: number,
  material = -1,
): void {
  const clipX = H_SIZE - 1;
  const clipY = map.sizeY - 1;
  const tables = getRadTables();

  const pset = (cx: number, cy: number, d: number) => map.pixSet(cx, cy, d, material);

  const r = rad - Math.floor((rad * smth) / 10);
  const d = 1.0 / (rad - r + 1);

  if (dh) {
    for (let i = 0; i <= r; i++) {
      const max = tables.maxRad[i];
      const xx = tables.ringX(i);
      const yy = tables.ringY(i);
      for (let j = 0; j < max; j++) {
        pset((x + xx[j]) & clipX, (y + yy[j]) & clipY, dh);
      }
    }

    for (let i = r + 1, dd = 1.0 - d; i <= rad; i++, dd -= d) {
      const max = tables.maxRad[i];
      if (!max) continue;
      const xx = tables.ringX(i);
      const yy = tables.ringY(i);
      let h = Math.trunc(dd * dh);
      if (!h) h = dh > 0 ? 1 : -1;

      switch (smode) {
        case 0: {
          const v = Math.trunc(dd * max);
          const ds = v / max;
          for (let s = ds, k = 0, j = locp % max; k < max; j = j + 1 === max ? 0 : j + 1, k++, s += ds) {
            if (s >= 1.0) {
              pset((x + xx[j]) & clipX, (y + yy[j]) & clipY, h);
              s -= 1.0;
            }
          }
          break;
        }
        case 1: {
          const v = Math.trunc(dd * 1000000.0);
          for (let j = 0; j < max; j++) {
            if (Math.trunc(Math.random() * 1000000) < v) {
              pset((x + xx[j]) & clipX, (y + yy[j]) & clipY, h);
            }
          }
          break;
        }
        case 2: {
          const v = Math.trunc(dd * max);
          for (let k = 0, j = locp % max; k < v; j = j + 1 === max ? 0 : j + 1, k++) {
            pset((x + xx[j]) & clipX, (y + yy[j]) & clipY, h);
          }
          locp += max;
          break;
        }
      }
    }
    locp++;
    return;
  }

  // dh == 0: smoothing around the mean height (current layer). Ported from the
  // `else` branch of deltaZone; `eql` limits how far a voxel may sit from the
  // local mean before it is left alone.
  const sizeX = map.sizeX;
  const baseRow = (yy: number) => (yy & clipY) * sizeX;

  const alt = (cx: number, cy: number) => map.getAlt(baseRow(cy) + cx, cx);

  const meanOrNeighbours = (cx: number, cy: number, mode0: boolean): number => {
    let v = 0;
    if (mode0) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) v += alt((cx + dx) & clipX, cy + dy);
      }
      return v >> 3;
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) === 2) v += alt((cx + dx) & clipX, cy + dy);
      }
    }
    return v >> 2;
  };

  let mean = 0;
  let k = 0;
  const rInner = r;
  if (eql) {
    for (let i = 0; i <= rInner; i++) {
      const max = tables.maxRad[i];
      const xx = tables.ringX(i);
      const yy = tables.ringY(i);
      for (let j = 0; j < max; j++) {
        mean += alt((x + xx[j]) & clipX, (y + yy[j]) & clipY);
      }
      k += max;
    }
    mean = k ? Math.trunc(mean / k) : 0;

    const apply = (cx: number, cy: number) => {
      const h = alt(cx, cy);
      if (Math.abs(h - mean) < eql) {
        if (h > mean) pset(cx, cy, -1);
        else if (h < mean) pset(cx, cy, 1);
      }
    };
    for (let i = 0; i <= rInner; i++) {
      const max = tables.maxRad[i];
      const xx = tables.ringX(i);
      const yy = tables.ringY(i);
      for (let j = 0; j < max; j++) apply((x + xx[j]) & clipX, (y + yy[j]) & clipY);
    }
    for (let i = r + 1, dd = 1.0 - d; i <= rad; i++, dd -= d) {
      const max = tables.maxRad[i];
      if (!max) continue;
      const xx = tables.ringX(i);
      const yy = tables.ringY(i);
      const v = Math.trunc(dd * max);
      const ds = v / max;
      for (let s = ds, kk = 0, j = locp % max; kk < max; j = j + 1 === max ? 0 : j + 1, kk++, s += ds) {
        if (s >= 1.0) {
          apply((x + xx[j]) & clipX, (y + yy[j]) & clipY);
          s -= 1.0;
        }
      }
    }
  } else {
    const apply = (cx: number, cy: number) => {
      const h = alt(cx, cy);
      const v = meanOrNeighbours(cx, cy, smode === 0);
      pset(cx, cy, v - h);
    };
    for (let i = 0; i <= rInner; i++) {
      const max = tables.maxRad[i];
      const xx = tables.ringX(i);
      const yy = tables.ringY(i);
      for (let j = 0; j < max; j++) apply((x + xx[j]) & clipX, (y + yy[j]) & clipY);
    }
    for (let i = r + 1, dd = 1.0 - d; i <= rad; i++, dd -= d) {
      const max = tables.maxRad[i];
      if (!max) continue;
      const xx = tables.ringX(i);
      const yy = tables.ringY(i);
      const v = Math.trunc(dd * max);
      const ds = v / max;
      for (let s = ds, kk = 0, j = locp % max; kk < max; j = j + 1 === max ? 0 : j + 1, kk++, s += ds) {
        if (s >= 1.0) {
          apply((x + xx[j]) & clipX, (y + yy[j]) & clipY);
          s -= 1.0;
        }
      }
    }
  }
  locp++;
}
