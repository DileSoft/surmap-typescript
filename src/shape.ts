/**
 * 3D-model insertion into the relief, ported from the SURMAP build:
 *   src/3d/3dobject.cpp       -> Model::loadC3D (non-COMPACT_3D = loadC3Dvariable)
 *   src/3d/3dgraph.h          -> DBM / DBV / Vertex
 *   surmap/3d_shape.cpp       -> Model::height_project / Polygon::height_project
 *   surmap/tools.cpp          -> S3Danalyze
 *
 * The model is loaded from a `.c3d` file, transformed (rotation + scale),
 * projected top-down into two buffers (max/min height), then stamped into the
 * terrain exactly like `S3Danalyze` does.
 */
import type { VrtMap } from './vmap';

export interface C3DModel {
  /** Interleaved x,y,z per vertex. */
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  readonly numVert: number;
  /** Triangles/polygons as vertex indices. */
  readonly polys: Int32Array[];
  readonly numPoly: number;
}

export interface ShapeOptions {
  /** Rotation around Z / X / Y (radians). */
  yaw: number;
  pitch: number;
  roll: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  /** Height offset added to every projected cell. */
  level: number;
  /** 0 map, 1 max, 2 min, 3 mean, 4 add. */
  mode: number;
  inverse: boolean;
  /** false = upper surface, true = lower surface. */
  side: boolean;
  noiseLevel: number;
  noiseAmp: number;
}

export interface ShapeProjection {
  dim: number;
  shift: number;
  /** Usable footprint side (`shape_size`); buffers are `dim` wide. */
  size: number;
  upper: Uint8Array;
  lower: Uint8Array;
  /** World voxel of the projection's top-left corner (may be negative). */
  shapeX: number;
  shapeY: number;
  /** Model-space bounds before placement (for the footprint preview). */
  xMin: number;
  yMin: number;
}

// --- C3D loader -------------------------------------------------------------

export function loadC3D(bytes: Uint8Array): C3DModel {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const i32 = () => {
    const v = view.getInt32(o, true);
    o += 4;
    return v;
  };
  const u32 = () => {
    const v = view.getUint32(o, true);
    o += 4;
    return v;
  };
  const f32 = () => {
    const v = view.getFloat32(o, true);
    o += 4;
    return v;
  };
  const skip = (n: number) => {
    o += n;
  };

  const version = i32();
  if (version !== 3 && version !== 8) {
    throw new Error(`Некорректная версия C3D: ${version}`);
  }
  const numVert = i32();
  const numNorm = i32();
  const numPoly = i32();
  i32(); // num_vert_total
  skip(10 * 4); // xmax..zmax, xmin..zmin, x_off..z_off, rmax
  const phi = i32();
  const psi = i32();
  const tetta = i32();
  if (version === 8) skip(8 + 3 * 8 + 9 * 8); // volume, rcm, J

  const all83 = phi === 83 && psi === 83 && tetta === 83;
  const vx = new Float64Array(numVert);
  const vy = new Float64Array(numVert);
  const vz = new Float64Array(numVert);
  for (let i = 0; i < numVert; i++) {
    if (all83) {
      vx[i] = f32();
      vy[i] = f32();
      vz[i] = f32();
    } else {
      vx[i] = i32();
      vy[i] = i32();
      vz[i] = i32();
    }
    skip(3); // x_8, y_8, z_8
    skip(4); // sort_info
  }
  skip(numNorm * 8); // x,y,z,n_power + sort_info

  const polys: Int32Array[] = [];
  for (let i = 0; i < numPoly; i++) {
    const num = i32();
    skip(4); // sort_info
    u32(); // color_id
    u32(); // color_shift
    skip(4); // flat_normal
    skip(3); // middle xyz
    const idx = new Int32Array(num);
    for (let j = 0; j < num; j++) {
      idx[j] = i32();
      i32(); // normal index
    }
    polys.push(idx);
  }

  return { vx, vy, vz, numVert, polys, numPoly };
}

// --- matrices (DBM) ---------------------------------------------------------

type Mat = Float64Array;

function matMul(a: Mat, b: Mat): Mat {
  const r = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

function diag(x: number, y: number, z: number): Mat {
  return new Float64Array([x, 0, 0, 0, y, 0, 0, 0, z]);
}

function rotZ(a: number): Mat {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float64Array([c, -s, 0, s, c, 0, 0, 0, 1]);
}

function rotX(a: number): Mat {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float64Array([1, 0, 0, 0, c, -s, 0, s, c]);
}

function rotY(a: number): Mat {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float64Array([c, 0, s, 0, 1, 0, -s, 0, c]);
}

/** `A_shape` for the given angles; at (0,0,0) it is diag(1,-1,-1) like surmap. */
function shapeMatrix(opts: ShapeOptions): Mat {
  let m = diag(1, -1, -1);
  m = matMul(rotY(opts.roll), m);
  m = matMul(rotX(opts.pitch), m);
  m = matMul(rotZ(opts.yaw), m);
  return m;
}

// --- projection (Model::height_project) ------------------------------------

function bitSR(x: number): number {
  const a = Math.abs(x);
  return a === 0 ? 0 : 31 - Math.clz32(a);
}

const div16 = (a: number, b: number): number => Math.trunc((a * 65536) / b);

export function projectShape(
  model: C3DModel,
  opts: ShapeOptions,
  xOff: number,
  yOff: number,
): ShapeProjection {
  const convert = matMul(shapeMatrix(opts), diag(opts.scaleX, opts.scaleY, opts.scaleZ));
  const n = model.numVert;

  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  const tz = new Float64Array(n);
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let zMin = Infinity;
  for (let i = 0; i < n; i++) {
    const x = model.vx[i];
    const y = model.vy[i];
    const z = model.vz[i];
    const rx = convert[0] * x + convert[1] * y + convert[2] * z;
    const ry = convert[3] * x + convert[4] * y + convert[5] * z;
    const rz = convert[6] * x + convert[7] * y + convert[8] * z;
    tx[i] = rx;
    ty[i] = ry;
    tz[i] = rz;
    if (rx < xMin) xMin = rx;
    if (rx > xMax) xMax = rx;
    if (ry < yMin) yMin = ry;
    if (ry > yMax) yMax = ry;
    if (-rz < zMin) zMin = -rz;
  }

  const size = Math.trunc(Math.max(xMax - xMin, yMax - yMin)) + 2;
  const shift = bitSR(size) + 1;
  const dim = 1 << shift;

  const upper = new Uint8Array(dim * dim);
  const lower = new Uint8Array(dim * dim).fill(255);

  // Buffer coordinates (model origin shifted to the bounding box).
  const bx = new Float64Array(n);
  const by = new Float64Array(n);
  const bz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    bx[i] = Math.trunc(tx[i] - xMin);
    by[i] = Math.trunc(ty[i] - yMin);
    bz[i] = Math.trunc(-tz[i] - zMin) + 1;
  }

  // Polygon::height_project
  const px = new Float64Array(64);
  const py = new Float64Array(64);
  const pz = new Float64Array(64);
  for (let pi = 0; pi < model.numPoly; pi++) {
    const idx = model.polys[pi];
    const num = idx.length;
    for (let j = 0; j < num; j++) {
      const vi = idx[j];
      px[j] = bx[vi];
      py[j] = by[vi];
      pz[j] = bz[vi];
    }
    rasterizePolygon(px, py, pz, num, shift, upper, lower);
  }

  return { dim, shift, size, upper, lower, shapeX: xOff + xMin - 1, shapeY: yOff + yMin, xMin, yMin };
}

function rasterizePolygon(
  px: Float64Array,
  py: Float64Array,
  pz: Float64Array,
  num: number,
  shift: number,
  upper: Uint8Array,
  lower: Uint8Array,
): void {
  const end = num - 1;
  let up = 0;
  for (let c = 1; c <= end; c++) if (py[up] > py[c]) up = c;

  let lfv = up;
  let rfv = up;
  let lti = up === 0 ? end : up - 1;
  let rti = up === end ? 0 : up + 1;

  let Y = py[up];
  let xl = px[up];
  let al = px[lti] - xl;
  let bl = py[lti] - Y;
  let ar = px[rti] - xl;
  let br = py[rti] - Y;
  xl = xl * 65536 + 32768;
  let xr = xl;

  let cl = pz[up];
  let ckl = pz[lti] - cl;
  let ckr = pz[rti] - cl;
  cl = cl * 65536;
  let cr = cl;

  if (bl) {
    al = div16(al, bl);
    ckl = div16(ckl, bl);
  }
  if (br) {
    ar = div16(ar, br);
    ckr = div16(ckr, br);
  }

  const stride = 1 << shift;
  let upOff = Y * stride;
  let loOff = Y * stride;

  for (;;) {
    let d: number;
    let where: number;
    if (bl > br) {
      d = br;
      where = 0;
    } else {
      d = bl;
      where = 1;
    }

    while (d-- > 0) {
      const x1 = xl >> 16;
      const x2 = xr >> 16;
      if (x1 !== x2) {
        let lo = x1;
        let hi = x2;
        let swapLog = false;
        if (lo > hi) {
          lo = x2;
          hi = x1;
          const t = cl;
          cl = cr;
          cr = t;
          swapLog = true;
        }
        const len = hi - lo;
        let cf = cl;
        const cfk = Math.trunc((cr - cl) / len);
        let uo = upOff + lo;
        let lp = loOff + lo;
        for (let k = 0; k < len; k++) {
          const z = cf >> 16;
          if (z > 0 && z < 256) {
            if (upper[uo] < z) upper[uo] = z;
            if (lower[lp] > z) lower[lp] = z;
          }
          cf += cfk;
          uo++;
          lp++;
        }
        if (swapLog) {
          const t = cl;
          cl = cr;
          cr = t;
        }
      }
      Y++;
      upOff += stride;
      loOff += stride;
      xl += al;
      xr += ar;
      cl += ckl;
      cr += ckr;
    }

    if (where) {
      if (lti === rti) break;
      lfv = lti;
      lti = lti === 0 ? end : lti - 1;
      br -= bl;
      xl = px[lfv];
      al = px[lti] - xl;
      bl = py[lti] - Y;
      xl = xl * 65536 + 32768;
      cl = pz[lfv];
      ckl = pz[lti] - cl;
      cl *= 65536;
      if (bl) {
        al = div16(al, bl);
        ckl = div16(ckl, bl);
      }
    } else {
      if (rti === lti) break;
      rfv = rti;
      rti = rti === end ? 0 : rti + 1;
      bl -= br;
      xr = px[rfv];
      ar = px[rti] - xr;
      br = py[rti] - Y;
      xr = xr * 65536 + 32768;
      cr = pz[rfv];
      ckr = pz[rti] - cr;
      cr *= 65536;
      if (br) {
        ar = div16(ar, br);
        ckr = div16(ckr, br);
      }
    }
  }
}

// --- stamping (S3Danalyze) --------------------------------------------------

/**
 * Applies a projected model to the terrain at `(xOff, yOff)` (model origin).
 * Returns the inclusive voxel region touched (unwrapped).
 */
export function stampShape(
  map: VrtMap,
  model: C3DModel,
  opts: ShapeOptions,
  xOff: number,
  yOff: number,
): { lowX: number; lowY: number; hiX: number; hiY: number } {
  const proj = projectShape(model, opts, xOff, yOff);
  const { size, shift, shapeX, shapeY } = proj;
  const surface = opts.side ? proj.lower : proj.upper;
  const empty = opts.side ? 255 : 0;

  const sizeX = map.sizeX;
  const clipX = sizeX - 1;
  const clipY = map.sizeY - 1;
  const stride = 1 << shift;

  for (let j = 0; j < size; j++) {
    const yy = (shapeY + j) & clipY;
    const rowBase = yy * sizeX;
    const pBase = j * stride;
    for (let i = 0; i < size; i++) {
      const p = surface[pBase + i];
      if (p === empty) continue;

      let v = opts.inverse ? -p : p;
      v += opts.level;
      if (
        opts.noiseLevel &&
        opts.noiseAmp &&
        Math.floor(Math.random() * 100) < opts.noiseLevel
      ) {
        v += opts.noiseAmp - Math.floor(Math.random() * (2 * opts.noiseAmp + 1));
      }

      const xx = (shapeX + i) & clipX;
      const h = map.height[rowBase + xx];
      let vv: number;
      switch (opts.mode) {
        case 0:
          vv = v;
          break;
        case 1:
          vv = Math.max(v, h);
          if (vv !== v) continue;
          break;
        case 2:
          vv = Math.min(v, h);
          if (vv !== v) continue;
          break;
        case 3:
          vv = (v + h) >> 1;
          break;
        default:
          vv = v + h;
          break;
      }
      map.pixSet(xx, yy, vv - h);
    }
  }

  return { lowX: shapeX, lowY: shapeY, hiX: shapeX + size - 1, hiY: shapeY + size - 1 };
}
