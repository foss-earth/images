import { encodePng, decodePng, resizeArea, encodeJpeg, decodeJpeg } from "@foss-earth/images/node";
const bytes = encodePng({ width: 2, height: 1, rgb: new Uint8Array(6) });
export const rgba = decodePng(bytes).rgba;
export const resized = resizeArea({ width: 2, height: 1, data: new Float32Array(6) }, 1, 1);
export const jpegWidth = decodeJpeg(encodeJpeg({ width: 1, height: 1, rgb: new Uint8Array(3) }, 90)).width;
