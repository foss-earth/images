export const MIB = 1024 * 1024;
/** RGBA8: four bytes a texel. */
const BYTES_PER_TEXEL = 4;

export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

/** Exact bytes of an RGBA8 chain: 4 × Σ W_l × H_l over the allocated levels, per layer. */
export function rgba8Bytes(width: number, height: number, levels = mipLevelCount(width, height), layers = 1): number {
  let texels = 0;
  for (let level = 0; level < levels; level++) texels += Math.max(1, width >> level) * Math.max(1, height >> level);
  return BYTES_PER_TEXEL * texels * layers;
}
