/** Source sampling/transfer fragment owned here; no shader device is created. */
export const SRGB_ENCODE_WGSL = /* wgsl */ `
fn panoramaSrgbEncode(linear: vec3<f32>) -> vec3<f32> {
  let c = clamp(linear, vec3<f32>(0.0), vec3<f32>(1.0));
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(high, low, c <= vec3<f32>(0.0031308));
}
`;
export const SRGB_ENCODE_GLSL = /* glsl */ `
vec3 panoramaSrgbEncode(vec3 linearColor) {
  vec3 c = clamp(linearColor, 0.0, 1.0);
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}
`;
export const SRGB_DECODE_GLSL = /* glsl */ `
vec3 panoramaSrgbDecode(vec3 encoded) {
  vec3 c = clamp(encoded, 0.0, 1.0);
  vec3 low = c / 12.92;
  vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(low, high, step(vec3(0.04045), c));
}
`;
