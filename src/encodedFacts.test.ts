import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { iccProfileDescription, readEncodedImageFacts, staticOpaqueSrgbProblem } from "./encodedFacts.js";

const fixtures = new URL("../fixtures/", import.meta.url);
const read = (path: string) => new Uint8Array(readFileSync(new URL(path, fixtures)));
const face = read("media/cardinal-grid/preview-64/px.jpg");

const be32 = (value: number) => [value >>> 24, (value >> 16) & 255, (value >> 8) & 255, value & 255];
const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));

/** A PNG of the given colour type with extra chunks before its image data. Checksums are not read, so they are zero. */
function png(colourType: number, chunks: [string, number[]][] = [], bitDepth = 8): Uint8Array {
  const chunk = (type: string, body: number[]) => [...be32(body.length), ...ascii(type), ...body, 0, 0, 0, 0];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...be32(4), ...be32(3), bitDepth, colourType, 0, 0, 0]),
    ...chunks.flatMap(([type, body]) => chunk(type, body)),
    ...chunk("IDAT", [0]),
    ...chunk("IEND", []),
  ]);
}

/** A minimal ICC profile whose only tag is a description of the given type. */
function icc(name: string, type: "desc" | "mluc"): number[] {
  const tag = type === "desc"
    ? [...ascii("desc"), 0, 0, 0, 0, ...be32(name.length + 1), ...ascii(name), 0, ...new Array(12).fill(0)]
    : [...ascii("mluc"), 0, 0, 0, 0, ...be32(1), ...be32(12), ...ascii("enUS"), ...be32(name.length * 2), ...be32(28), ...[...name].flatMap(c => [0, c.charCodeAt(0)])];
  const header = new Array(128).fill(0);
  return [...header, ...be32(1), ...ascii("desc"), ...be32(144), ...be32(tag.length), ...tag];
}

/** A JPEG with its ICC profile split across APP2 segments after SOI. */
function withProfile(jpeg: Uint8Array, profile: number[], parts: number): Uint8Array {
  const size = Math.ceil(profile.length / parts);
  const segments = Array.from({ length: parts }, (_, index) => {
    const body = [...ascii("ICC_PROFILE"), 0, index + 1, parts, ...profile.slice(index * size, (index + 1) * size)];
    return [0xff, 0xe2, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  });
  // Out of order on purpose: the sequence numbers decide.
  return new Uint8Array([...jpeg.subarray(0, 2), ...segments.reverse().flat(), ...jpeg.subarray(2)]);
}

describe("encoded image facts", () => {
  it("reads an ordinary JPEG as static, opaque, untagged 8-bit colour", async () => {
    const facts = await readEncodedImageFacts(face);
    expect(facts).toMatchObject({ alpha: false, animated: false, bitDepth: 8, components: 3, cicp: null, colour: { iccProfileName: null } });
    expect(staticOpaqueSrgbProblem(facts!)).toBeNull();
  });

  it("reads a JPEG's profile description across segments, and refuses one that is not sRGB", async () => {
    const srgb = await readEncodedImageFacts(withProfile(face, icc("sRGB IEC61966-2.1", "desc"), 3));
    expect(srgb!.colour.iccProfileName).toBe("sRGB IEC61966-2.1");
    expect(staticOpaqueSrgbProblem(srgb!)).toBeNull();
    const p3 = await readEncodedImageFacts(withProfile(face, icc("Display P3", "mluc"), 2));
    expect(p3!.colour.iccProfileName).toBe("Display P3");
    expect(staticOpaqueSrgbProblem(p3!)).toContain('ICC profile "Display P3" is not sRGB');
  });

  it("names grey and 12-bit JPEGs, and refuses CMYK and deep ones", async () => {
    expect((await readEncodedImageFacts(read("jpeg/grey.jpg")))!.components).toBe(1);
    const deep = await readEncodedImageFacts(read("jpeg/12-bit.jpg"));
    expect(deep!.bitDepth).toBe(12);
    expect(staticOpaqueSrgbProblem(deep!)).toContain("12 bits per channel");
    const cmyk = face.slice();
    for (let at = 2; at < cmyk.length;) {
      const marker = cmyk[at + 1], length = (cmyk[at + 2] << 8) | cmyk[at + 3];
      if (marker === 0xc0) { cmyk[at + 9] = 4; break; }
      at += 2 + length;
    }
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(cmyk))!)).toContain("CMYK");
  });

  it("refuses a turned JPEG by its orientation", async () => {
    const tiff = [0x4d, 0x4d, 0, 42, ...be32(8), 0, 1, 0x01, 0x12, 0, 3, ...be32(1), 0, 6, 0, 0, ...be32(0)];
    const body = [...ascii("Exif"), 0, 0, ...tiff];
    const turned = new Uint8Array([...face.subarray(0, 2), 0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body, ...face.subarray(2)]);
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(turned))!)).toContain("EXIF orientation 6");
  });

  it("reads a PNG's transparency, animation and colour chunks", async () => {
    const plain = await readEncodedImageFacts(png(2));
    expect(plain).toMatchObject({ alpha: false, animated: false, components: 3 });
    expect(staticOpaqueSrgbProblem(plain!)).toBeNull();
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(png(6)))!)).toContain("partly transparent");
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(png(4)))!)).toContain("partly transparent");
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(png(2, [["tRNS", [0, 0, 0, 0, 0, 0]]])))!)).toContain("partly transparent");
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(png(2, [["acTL", [...be32(2), ...be32(0)]]])))!)).toContain("animated");
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(png(2, [], 16)))!)).toContain("16 bits");
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(png(2, [["sRGB", [0]]])))!)).toBeNull();
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(png(2, [["gAMA", be32(45455)]])))!)).toBeNull();
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(png(2, [["gAMA", be32(100000)]])))!)).toContain("gamma 1");
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(png(2, [["cICP", [1, 13, 0, 1]]])))!)).toBeNull();
    expect(staticOpaqueSrgbProblem((await readEncodedImageFacts(png(2, [["cICP", [9, 16, 0, 1]]])))!)).toContain("primaries 9 and transfer 16");
  });

  it("inflates a PNG's embedded profile to read its description", async () => {
    const iccp = (name: string, profile: number[]) => [...ascii(name), 0, 0, ...deflateSync(new Uint8Array(profile))];
    const srgb = await readEncodedImageFacts(png(2, [["iCCP", iccp("ICC Profile", icc("sRGB built-in", "mluc"))]]));
    expect(srgb!.colour.iccProfileName).toBe("sRGB built-in");
    expect(staticOpaqueSrgbProblem(srgb!)).toBeNull();
    const wide = await readEncodedImageFacts(png(2, [["iCCP", iccp("ICC Profile", icc("Adobe RGB (1998)", "desc"))]]));
    expect(staticOpaqueSrgbProblem(wide!)).toContain('"Adobe RGB (1998)" is not sRGB');
    // A profile that does not inflate is named by its chunk's own name.
    const broken = await readEncodedImageFacts(png(2, [["iCCP", [...ascii("Camera RGB"), 0, 0, 1, 2, 3]]]));
    expect(broken!.colour.iccProfileName).toBe("Camera RGB");
  });

  it("refuses cut-short or foreign bytes", async () => {
    expect(await readEncodedImageFacts(new Uint8Array([1, 2, 3]))).toBeNull();
    const cut = png(2, [["sRGB", [0]]]);
    expect(await readEncodedImageFacts(cut.subarray(0, 40))).toBeNull();
    expect(iccProfileDescription(new Uint8Array(20))).toBe("unreadable profile");
  });
});
