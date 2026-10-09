import { SRGB_ENCODE_WGSL, SRGB_ENCODE_GLSL, SRGB_DECODE_GLSL } from "@foss-earth/images/shaders";
export const sharedSourceFragments: readonly string[] = [SRGB_ENCODE_WGSL, SRGB_ENCODE_GLSL, SRGB_DECODE_GLSL];
