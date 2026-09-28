/**
 * `RenderPrepare` from src/terra/land.cpp (the ROAD/game build, TERRAIN16 off).
 * Builds the two lookup tables used by every surface renderer:
 *   lightCLR[terrain][255 - (lx - rx)]  -> diffuse light term 0..255
 *   palCLR[terrain][512]                -> palette index ramp (offset 256)
 */
import {
  CLR_MAX,
  CLR_MAX_SIDE,
  MATERIAL_MAX,
  SHADOWDEEP,
  TERRAIN_DXKOEF,
  TERRAIN_JJKOEF,
  TERRAIN_MATERIAL,
  TERRAIN_MAX,
  TERRAIN_SDKOEF,
} from './constants';

export interface Luts {
  lightCLR: Uint8Array[];
  palCLR: Uint8Array[];
  FloodLEVEL: number;
}

export function renderPrepare(
  beginColors: number[],
  endColors: number[],
  floodLevel: number,
): Luts {
  const floodLEVEL = floodLevel & 0xff;

  // --- lightCLRmaterial -----------------------------------------------------
  const lightCLRmaterial: Uint8Array[] = [];
  const dx = 8.0;
  const sd = 256.0 / SHADOWDEEP;
  for (let ind = 0; ind < MATERIAL_MAX; ind++) {
    const DX = TERRAIN_DXKOEF[ind] * dx;
    const SD = TERRAIN_SDKOEF[ind] * sd;
    const table = new Uint8Array(CLR_MAX);
    for (let j = -CLR_MAX_SIDE; j <= CLR_MAX_SIDE; j++) {
      const jj = TERRAIN_JJKOEF[ind] * j;
      let v = Math.round(
        (255.0 * (DX * SD - jj)) / Math.sqrt((1.0 + SD * SD) * (DX * DX + jj * jj)),
      );
      if (v < 0) v = 0;
      table[CLR_MAX_SIDE + j] = v;
    }
    lightCLRmaterial.push(table);
  }

  // --- lightCLR[terrain] + palCLR[terrain] ----------------------------------
  const lightCLR: Uint8Array[] = [];
  const palCLR: Uint8Array[] = [];
  for (let ind = 0; ind < TERRAIN_MAX; ind++) {
    lightCLR.push(lightCLRmaterial[TERRAIN_MATERIAL[ind]]);

    const pal = new Uint8Array(2 * 256).fill(beginColors[ind]);
    const colnum = endColors[ind] - beginColors[ind];

    if (ind === 0) {
      // Water: special ramp that clamps to the flood level.
      const d = (255 - floodLEVEL) >> 1;
      if (d > 0) {
        pal.fill(endColors[ind], 2 * 256 - d, 2 * 256);
      }
      for (let j = 0; j < 256 - d; j++) {
        let v = Math.round((j * 1.25 * colnum) / (255.0 - d) - 0.25 * colnum);
        if (v < 0) v = 0;
        pal[256 + j] = beginColors[ind] + v;
      }
    } else {
      for (let j = 0; j < 256; j++) {
        pal[256 + j] = beginColors[ind] + Math.round((j * colnum) / 255.0);
      }
    }
    palCLR.push(pal);
  }

  return { lightCLR, palCLR, FloodLEVEL: floodLEVEL };
}
