/**
 * LEATHER FRAME COORDINATES
 * Defines where leather region appears on the surface texture
 */

export interface LeatherFrameType {
  x: number;
  y: number;
  width: number;
  height: number;
  surfaceWidth: number;
  surfaceHeight: number;
}

/**
 * Leather frame coordinates (where leather image goes on surface)
 * Based on the surface.jpg UV layout
 */
export const LEATHER_FRAME: LeatherFrameType = {
  x: 0,
  y: 3660,
  width: 1141,
  height: 3464,
  surfaceWidth: 1141,
  surfaceHeight: 8359,
};

/**
 * Calculate leather region bounds as ratios (0-1)
 */
export function getLeatherBoundsRatio(): { startY: number; endY: number } {
  return {
    startY: LEATHER_FRAME.y / LEATHER_FRAME.surfaceHeight,
    endY: (LEATHER_FRAME.y + LEATHER_FRAME.height) / LEATHER_FRAME.surfaceHeight,
  };
}
