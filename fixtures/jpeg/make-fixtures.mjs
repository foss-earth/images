// Writes the JPEG fixtures for tests/jpeg-codecs.test.ts with libjpeg-turbo's
// cjpeg, in layouts jpeg-js's encoder cannot write. libjpeg-turbo 3.2.0 made
// the committed files:
//   node fixtures/jpeg/make-fixtures.mjs [path/to/cjpeg]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const cjpeg = process.argv[2] ?? "cjpeg";
const here = new URL(".", import.meta.url), scratch = new URL("../../build/", import.meta.url);
mkdirSync(scratch, { recursive: true });
const scans = new URL("jpeg-fixture-scans.txt", scratch);
writeFileSync(scans, "0;\n1;\n2;\n"); // each component in a scan of its own

// 33 x 17 pixels of gradients, block-edged steps and noise: partial MCUs both ways.
const width = 33, height = 17, rgb = new Uint8Array(width * height * 3);
let seed = 2026;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i += 3) {
  const base = 128 + 100 * Math.sin(3 * x / width * Math.PI) * Math.cos(2 * y / height * Math.PI);
  const step = ((x >> 2) + (y >> 3)) & 1 ? 35 : -35, noise = (random() - 0.5) * 40;
  rgb[i] = clamp(base + step + noise); rgb[i + 1] = clamp(0.8 * base + noise + 30 * Math.sin(x / 3)); rgb[i + 2] = clamp(255 - base - step + noise);
}
const ppm = Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, "latin1"), rgb]);

const layouts = {
  "420-optimized": ["-sample", "2x2", "-optimize"],
  "422": ["-sample", "2x1"],
  "440": ["-sample", "1x2"],
  "411": ["-sample", "4x1"],
  "mixed-sampling": ["-sample", "2x2,1x1,2x1"],
  "chroma-larger": ["-sample", "1x1,2x2,1x1"],
  "grey": ["-grayscale"],
  "grey-restart-5-blocks": ["-grayscale", "-restart", "5B"],
  "420-restart-3-blocks": ["-sample", "2x2", "-restart", "3B"],
  "separate-scans": ["-sample", "2x2", "-scans", scans.pathname],
  "rgb": ["-rgb"],
  "progressive": ["-sample", "2x2", "-progressive"],
  "arithmetic": ["-sample", "2x2", "-arithmetic"],
  "12-bit": ["-precision", "12"],
};
for (const [name, args] of Object.entries(layouts)) {
  const result = spawnSync(cjpeg, ["-quality", "90", ...args], { input: ppm });
  if (result.status !== 0) throw new Error(`cjpeg ${args.join(" ")}: ${result.stderr}`);
  writeFileSync(new URL(`${name}.jpg`, here), result.stdout);
}
