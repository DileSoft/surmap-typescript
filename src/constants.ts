/**
 * Constants ported 1:1 from the original Vangers sources:
 *   src/common.h, src/terra/world.h, src/terra/render.h, src/terra/huff1.cpp
 *
 * Only the non-TERRAIN16, non-_SURMAP_ (i.e. the actual game / road) build is
 * reproduced, because that is what ships in the retail game.
 */

// src/common.h
export const MAP_POWER_X = 11;
export const H_POWER = MAP_POWER_X;
export const H_SIZE = 1 << H_POWER; // 2048
export const H2_SIZE = 2 * H_SIZE; // 4096

// src/terra/world.h (TERRAIN16 is NOT defined)
export const TERRAIN_MAX = 8;
export const TERRAIN_OFFSET = 3;
export const TERRAIN_MASK =
  (1 << TERRAIN_OFFSET) | (1 << (TERRAIN_OFFSET + 1)) | (1 << (TERRAIN_OFFSET + 2)); // 0x38

// flag byte layout: [7 SHADOW][6 DOUBLE_LEVEL][5..3 TERRAIN][2 OBJSHADOW][1..0 DELTA]
export const SHADOW_MASK = 1 << 7; // 0x80
export const DOUBLE_LEVEL = 1 << 6; // 0x40
export const OBJSHADOW = 1 << 2; // 0x04
export const DELTA_MASK = 0x03;
export const DELTA_SHIFT = 3;

export const WATER_TERRAIN_INDEX = 0;
export const MAIN_TERRAIN_INDEX = 1;
export const WATER_TERRAIN = WATER_TERRAIN_INDEX << TERRAIN_OFFSET;
export const MAIN_TERRAIN = MAIN_TERRAIN_INDEX << TERRAIN_OFFSET;

// src/common.h (the _SURMAP_ build; the game uses 48)
export const MAX_RADIUS = 175;

// src/terra/render.h
export const H_CORRECTION = 1;
export const CLR_MAX_SIDE = 255;
export const CLR_MAX = 2 * CLR_MAX_SIDE + 1; // 511

// src/terra/world.h + src/terra/siderend.cpp
export const SS_WIDTH = 16;
export const SHADOWDEEP = 384;
export const SHADOWHEIGHT = 32;
export const POSPOWER = 8;
export const MAX_ALT = 255;

// Land.cpp materials table (TERRAIN16 is not defined)
export const MATERIAL_MAX = 2;
export const TERRAIN_MATERIAL = [1, 0, 0, 0, 0, 0, 0, 0];
export const TERRAIN_DXKOEF = [1.0, 5.0];
export const TERRAIN_SDKOEF = [1.0, 1.25];
export const TERRAIN_JJKOEF = [1.0, 0.5];

/** `x & clip_mask_x` for MAP_POWER_X = 11. */
export function xcycl(x: number): number {
  return x & (H_SIZE - 1);
}
