import type { RenderSettings, Vec3 } from '../types/contracts';

export interface RenderBudget {
  pixelRatio: number;
  maxShadowSize: number;
  probeSize: number;
  planarScale: number;
}

/** Quality changes GPU work without changing the mathematical sampling grid. */
export function resolveInteractiveRenderBudget(
  quality: RenderSettings['interactiveQuality'],
  devicePixelRatio = 1,
): RenderBudget {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (quality === 'performance') {
    return { pixelRatio: Math.min(dpr, 1), maxShadowSize: 512, probeSize: 64, planarScale: 0.25 };
  }
  if (quality === 'balanced') {
    return { pixelRatio: Math.min(dpr, 1.5), maxShadowSize: 1024, probeSize: 96, planarScale: 0.5 };
  }
  return { pixelRatio: Math.min(dpr, 3), maxShadowSize: 4096, probeSize: 128, planarScale: 0.75 };
}

/** PNGs spend more work per frame, but do not multiply six-face point maps
 * without bound. Budget about 256 MiB for shadow attachments (four bytes each).
 */
export function resolvePngExportBudget(
  scale: number,
  requestedShadowSize: number,
  directional: boolean,
  pointLightCount: number,
  transparentCasters: boolean,
  maxTextureSize = 4096,
): RenderBudget {
  const target = Math.max(requestedShadowSize, scale > 1 ? 4096 : 2048);
  const attachments = Math.max(1, (Number(directional) + 6 * pointLightCount) * (transparentCasters ? 3 : 1));
  const memoryLimit = Math.sqrt((256 * 1024 * 1024) / (4 * attachments));
  const limit = Math.min(target, memoryLimit, maxTextureSize, 4096);
  // Depth maps need no mipmaps, so WebGL2 permits intermediate sizes. Avoid
  // dropping a 1536px map to 1024px just to round to a power of two.
  const maxShadowSize = Math.max(256, Math.floor(limit / 256) * 256);
  return { pixelRatio: 1, maxShadowSize, probeSize: Math.min(scale > 1 ? 512 : 256, maxTextureSize), planarScale: 1 };
}

/** A vertical light needs a horizontal up axis for a nonsingular lookAt matrix. */
export function resolveShadowUpVector(direction: Vec3): [number, number, number] {
  return Math.abs(direction.z) > 0.99 ? [0, 1, 0] : [0, 0, 1];
}

/** Bound total capture working memory, including GPU targets, mipmaps and CPU
 * readback/encoding copies. Reserve 256 MiB for shadows and 80 MiB for probes,
 * fixed resources and the retained preview; spend the rest of 768 MiB on pixels.
 * Geometry is retained, not duplicated by capture, and is outside this budget.
 */
export function resolvePngExportScale(
  width: number, height: number, requestedScale: number, maxDimension: number,
  effects: { hdr: boolean; bloom: boolean; refraction: boolean; selection: boolean; mirror: boolean },
): number {
  const color = effects.hdr ? 8 : 4;
  const bytesPerPixel = color + 4 + 24
    + (effects.bloom ? color / 2 : 0)
    + (effects.refraction ? color * 4 / 3 : 0)
    + (effects.selection ? 8 : 0)
    + (effects.mirror ? color * 4 / 3 + 4 : 0);
  const pixelBudget = (768 - 256 - 80) * 1024 * 1024 / bytesPerPixel;
  return Math.max(1 / Math.max(width, height), Math.min(requestedScale,
    maxDimension / Math.max(width, height), Math.sqrt(pixelBudget / Math.max(1, width * height))));
}
