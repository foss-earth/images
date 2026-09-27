/**
 * Pure validation of a `foss-earth-scene` v1 document. Allocates nothing on
 * the GPU and makes no requests: every check the format asks for before
 * resources are spent (§2), with the JSON path of each failure.
 */
import type { CubeFaceName } from "./panoramaMath";
import { CUBE_FACE_NAMES } from "./panoramaMath";
import {
  SCENE_FORMAT,
  SCENE_FORMAT_VERSION,
  type AttributionRecord,
  type GroupRecord,
  type HeightRecord,
  type LinkRecord,
  type OverviewRecord,
  type ResolvedMarkerStyle,
  type ResolvedAsset,
  type ResolvedPanorama,
  type ResolvedRepresentation,
  type SceneDiagnostic,
  type SceneExtensions,
  type SceneValidation,
  type UnsupportedEntity,
  type ViewRecord,
} from "./format";

/** How much of a scene the loader accepts: `scene.manifestMiB`, `scene.entityLimit`, `scene.assetLimit`, `scene.linkLimit`. */
export interface SceneLimits {
  manifestBytes: number;
  entities: number;
  assets: number;
  links: number;
}

export interface ValidateSceneOptions {
  /**
   * What relative media and credit URLs resolve against: a manifest's final
   * response URL. Programmatic JSON with relative URLs needs one.
   */
  baseUrl?: string | URL | null;
  limits?: Partial<SceneLimits>;
  /** Extension names this loader implements; v1 implements none. */
  supportedExtensions?: readonly string[];
}

const ID = /^[A-Za-z0-9._-]+$/;
/** An extension key names its owner: `owner.name`, lower-case owner. */
const EXTENSION_KEY = /^[a-z0-9-]+(\.[A-Za-z0-9_-]+)+$/;
const MIME_TYPES = ["image/jpeg", "image/png"] as const;
/** A CSS hex colour with or without alpha: `#rrggbb` or `#rrggbbaa`. */
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** The format's bounds on an outline's width, CSS px, and on hover growth. */
const OUTLINE_WIDTH_PX = { min: 0, max: 32 };
const HOVER_SCALE = { min: 1, max: 4 };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

class Checker {
  readonly errors: SceneDiagnostic[] = [];
  readonly warnings: SceneDiagnostic[] = [];

  fail(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  warn(path: string, message: string): void {
    this.warnings.push({ path, message });
  }

  record(value: unknown, path: string): Json | null {
    if (isRecord(value)) return value;
    this.fail(path, "must be an object");
    return null;
  }

  /** Unknown properties in a known record fail; `extensions` is the place for more. */
  keys(record: Json, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) this.fail(`${path}.${key}`, `is not a property of this record; namespaced additions belong in "extensions"`);
    }
  }

  id(value: unknown, path: string): string | null {
    if (typeof value === "string" && value.length > 0 && ID.test(value)) return value;
    this.fail(path, "must be a nonempty ASCII id of letters, digits, '.', '_' or '-'");
    return null;
  }

  text(value: unknown, path: string, optional = false): string | null {
    if (value === undefined && optional) return null;
    if (typeof value === "string" && value.trim().length > 0) return value;
    this.fail(path, "must be nonempty text");
    return null;
  }

  finite(value: unknown, path: string): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    this.fail(path, "must be a finite number");
    return null;
  }

  /** `closedMin`/`closedMax` say whether each end is included. */
  within(value: unknown, path: string, min: number, max: number, closedMin: boolean, closedMax: boolean): number | null {
    const number = this.finite(value, path);
    if (number === null) return null;
    const aboveMin = closedMin ? number >= min : number > min;
    const belowMax = closedMax ? number <= max : number < max;
    if (aboveMin && belowMax) return number;
    this.fail(path, `must be in ${closedMin ? "[" : "("}${min}, ${max}${closedMax ? "]" : ")"}`);
    return null;
  }

  positiveInteger(value: unknown, path: string): number | null {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    this.fail(path, "must be a positive whole number");
    return null;
  }

  nonNegative(value: unknown, path: string): number | null {
    const number = this.finite(value, path);
    if (number === null) return null;
    if (number >= 0) return number;
    this.fail(path, "must not be negative");
    return null;
  }

  oneOf<T extends string>(value: unknown, path: string, choices: readonly T[]): T | null {
    if (typeof value === "string" && (choices as readonly string[]).includes(value)) return value as T;
    this.fail(path, `must be one of ${choices.map(choice => JSON.stringify(choice)).join(", ")}`);
    return null;
  }

  array(value: unknown, path: string): unknown[] | null {
    if (Array.isArray(value)) return value;
    this.fail(path, "must be an array");
    return null;
  }

  extensions(value: unknown, path: string): SceneExtensions {
    if (value === undefined) return {};
    const record = this.record(value, path);
    if (!record) return {};
    const out: Record<string, Readonly<Record<string, unknown>>> = {};
    for (const [key, data] of Object.entries(record)) {
      if (!EXTENSION_KEY.test(key)) this.fail(`${path}.${key}`, "must be a namespaced key such as \"owner.name\"");
      else if (!isRecord(data)) this.fail(`${path}.${key}`, "must be an object");
      else out[key] = data;
    }
    return out;
  }
}

function resolveUrl(checker: Checker, value: unknown, path: string, base: URL | null): string | null {
  if (typeof value !== "string" || value.length === 0) {
    checker.fail(path, "must be a URL");
    return null;
  }
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    checker.fail(path, base ? "is not a valid URL" : "is relative, and the scene has no base URL to resolve it against");
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    checker.fail(path, "must resolve to an http or https URL; local files go through a file resolver");
    return null;
  }
  if (url.username || url.password) {
    checker.fail(path, "must not carry credentials");
    return null;
  }
  return url.href;
}

function checkHeight(checker: Checker, value: unknown, path: string): HeightRecord | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const record = checker.record(value, path);
  if (!record) return null;
  checker.keys(record, path, ["meters", "datum", "source", "uncertaintyMeters"]);
  const meters = checker.finite(record.meters, `${path}.meters`);
  const datum = checker.oneOf(record.datum, `${path}.datum`, ["WGS84-ellipsoid"] as const);
  const source = record.source === undefined ? undefined : checker.text(record.source, `${path}.source`);
  const uncertainty = record.uncertaintyMeters === undefined ? undefined : checker.nonNegative(record.uncertaintyMeters, `${path}.uncertaintyMeters`);
  if (meters === null || datum === null) return null;
  return {
    meters,
    datum,
    ...(source ? { source } : {}),
    ...(uncertainty !== undefined && uncertainty !== null ? { uncertaintyMeters: uncertainty } : {}),
  };
}

function checkView(checker: Checker, value: unknown, path: string): ViewRecord | null {
  const record = checker.record(value, path);
  if (!record) return null;
  checker.keys(record, path, ["headingDeg", "pitchDeg", "verticalFovDeg"]);
  const headingDeg = checker.within(record.headingDeg, `${path}.headingDeg`, 0, 360, true, false);
  const pitchDeg = checker.within(record.pitchDeg, `${path}.pitchDeg`, -90, 90, true, true);
  const verticalFovDeg = checker.within(record.verticalFovDeg, `${path}.verticalFovDeg`, 0, 180, false, false);
  return headingDeg === null || pitchDeg === null || verticalFovDeg === null ? null : { headingDeg, pitchDeg, verticalFovDeg };
}

function checkLongitudeLatitude(checker: Checker, record: Json, path: string): { longitudeDeg: number; latitudeDeg: number } | null {
  const longitudeDeg = checker.within(record.longitudeDeg, `${path}.longitudeDeg`, -180, 180, true, false);
  const latitudeDeg = checker.within(record.latitudeDeg, `${path}.latitudeDeg`, -90, 90, true, true);
  return longitudeDeg === null || latitudeDeg === null ? null : { longitudeDeg, latitudeDeg };
}

function checkAttribution(checker: Checker, value: unknown, path: string, base: URL | null): AttributionRecord | null {
  const record = checker.record(value, path);
  if (!record) return null;
  checker.keys(record, path, ["text", "license", "url"]);
  const text = checker.text(record.text, `${path}.text`);
  const license = record.license === undefined ? null : checker.text(record.license, `${path}.license`);
  const url = record.url === undefined ? null : resolveUrl(checker, record.url, `${path}.url`, base);
  return text === null ? null : { text, ...(license ? { license } : {}), ...(url ? { url } : {}) };
}

function checkRepresentation(checker: Checker, value: unknown, path: string, base: URL | null): ResolvedRepresentation | null {
  const record = checker.record(value, path);
  if (!record) return null;
  const projection = checker.oneOf(record.projection, `${path}.projection`, ["cube", "equirectangular"] as const);
  const common = ["id", "role", "projection", "mimeType", "encodedBytes", "extensions"];
  checker.keys(record, path, projection === "cube" ? [...common, "faceSize", "faces"] : [...common, "width", "height", "url"]);
  const id = checker.id(record.id, `${path}.id`);
  const role = checker.oneOf(record.role, `${path}.role`, ["preview", "immersion"] as const);
  const mimeType = checker.oneOf(record.mimeType, `${path}.mimeType`, MIME_TYPES);
  const encodedBytes = checker.positiveInteger(record.encodedBytes, `${path}.encodedBytes`);
  const extensions = checker.extensions(record.extensions, `${path}.extensions`);
  if (projection === "cube") {
    const faceSize = checker.positiveInteger(record.faceSize, `${path}.faceSize`);
    const faces = checker.record(record.faces, `${path}.faces`);
    const resolved: Partial<Record<CubeFaceName, string>> = {};
    if (faces) {
      checker.keys(faces, `${path}.faces`, CUBE_FACE_NAMES);
      for (const face of CUBE_FACE_NAMES) {
        if (faces[face] === undefined) { checker.fail(`${path}.faces.${face}`, "is missing: a cube needs all six faces"); continue; }
        const url = resolveUrl(checker, faces[face], `${path}.faces.${face}`, base);
        if (url) resolved[face] = url;
      }
    }
    if (!id || !role || !mimeType || !encodedBytes || !faceSize || Object.keys(resolved).length !== 6) return null;
    return { id, role, projection, mimeType, encodedBytes, faceSize, faces: resolved as Record<CubeFaceName, string>, ...(Object.keys(extensions).length ? { extensions } : {}) };
  }
  if (projection === "equirectangular") {
    const width = checker.positiveInteger(record.width, `${path}.width`);
    const height = checker.positiveInteger(record.height, `${path}.height`);
    if (width !== null && height !== null && width !== 2 * height) checker.fail(`${path}.width`, "must be twice the height: a full 2:1 equirectangular image");
    const url = resolveUrl(checker, record.url, `${path}.url`, base);
    if (!id || !role || !mimeType || !encodedBytes || !width || !height || width !== 2 * height || !url) return null;
    return { id, role, projection, mimeType, encodedBytes, width, height, url, ...(Object.keys(extensions).length ? { extensions } : {}) };
  }
  return null;
}

function checkAsset(checker: Checker, value: unknown, path: string, base: URL | null): { asset: ResolvedAsset | null; unsupportedType: string | null; id: string | null } {
  const record = checker.record(value, path);
  if (!record) return { asset: null, unsupportedType: null, id: null };
  const id = checker.id(record.id, `${path}.id`);
  if (record.type !== "panorama-image") {
    // A later asset type: kept as an id so references to it are known, not shown.
    if (typeof record.type !== "string") checker.fail(`${path}.type`, "must be text");
    else checker.warn(`${path}.type`, `asset type "${record.type}" is not supported by this loader`);
    return { asset: null, unsupportedType: typeof record.type === "string" ? record.type : null, id };
  }
  checker.keys(record, path, ["id", "revision", "type", "colorSpace", "alpha", "attribution", "representations", "extensions"]);
  const revision = checker.text(record.revision, `${path}.revision`);
  const colorSpace = checker.oneOf(record.colorSpace, `${path}.colorSpace`, ["srgb"] as const);
  const alpha = checker.oneOf(record.alpha, `${path}.alpha`, ["opaque"] as const);
  const attribution = checkAttribution(checker, record.attribution, `${path}.attribution`, base);
  const extensions = checker.extensions(record.extensions, `${path}.extensions`);
  const list = checker.array(record.representations, `${path}.representations`) ?? [];
  const representations: ResolvedRepresentation[] = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const representation = checkRepresentation(checker, entry, `${path}.representations[${index}]`, base);
    if (!representation) return;
    if (seen.has(representation.id)) checker.fail(`${path}.representations[${index}].id`, `repeats representation id "${representation.id}" in this asset`);
    seen.add(representation.id);
    representations.push(representation);
  });
  if (!representations.some(entry => entry.role === "preview" && entry.projection === "cube")) {
    checker.fail(`${path}.representations`, "needs at least one complete preview cube");
  }
  if (!id || !revision || !colorSpace || !alpha || !attribution) return { asset: null, unsupportedType: null, id };
  return {
    asset: { id, revision, type: "panorama-image", colorSpace, alpha, attribution, representations, ...(Object.keys(extensions).length ? { extensions } : {}) },
    unsupportedType: null,
    id,
  };
}

function checkLink(checker: Checker, value: unknown, path: string): LinkRecord | null {
  const record = checker.record(value, path);
  if (!record) return null;
  checker.keys(record, path, ["id", "target", "label", "direction", "arrivalView", "extensions"]);
  const id = checker.id(record.id, `${path}.id`);
  const target = checker.id(record.target, `${path}.target`);
  const label = checker.text(record.label, `${path}.label`);
  let direction: LinkRecord["direction"];
  if (record.direction !== undefined) {
    const dir = checker.record(record.direction, `${path}.direction`);
    if (dir) {
      checker.keys(dir, `${path}.direction`, ["headingDeg", "pitchDeg"]);
      const headingDeg = checker.within(dir.headingDeg, `${path}.direction.headingDeg`, 0, 360, true, false);
      const pitchDeg = checker.within(dir.pitchDeg, `${path}.direction.pitchDeg`, -90, 90, true, true);
      if (headingDeg !== null && pitchDeg !== null) direction = { headingDeg, pitchDeg };
    }
  }
  const arrivalView = record.arrivalView === undefined ? undefined : checkView(checker, record.arrivalView, `${path}.arrivalView`) ?? undefined;
  const extensions = checker.extensions(record.extensions, `${path}.extensions`);
  if (!id || !target || !label) return null;
  return { id, target, label, ...(direction ? { direction } : {}), ...(arrivalView ? { arrivalView } : {}), ...(Object.keys(extensions).length ? { extensions } : {}) };
}

/** A style's own properties: undefined inherits the scene's, null turns it off. */
type StyleOverrides = { outline?: ResolvedMarkerStyle["outline"]; hover?: number | null };

function checkMarkerStyle(checker: Checker, value: unknown, path: string): StyleOverrides {
  const record = checker.record(value, path);
  if (!record) return {};
  checker.keys(record, path, ["outline", "hover"]);
  const style: StyleOverrides = {};
  if (record.outline === null) style.outline = null;
  else if (record.outline !== undefined) {
    const outline = checker.record(record.outline, `${path}.outline`);
    if (outline) {
      checker.keys(outline, `${path}.outline`, ["color", "widthPx"]);
      const text = outline.color;
      if (typeof text !== "string" || !HEX_COLOUR.test(text)) checker.fail(`${path}.outline.color`, "must be a hex colour, #rrggbb or #rrggbbaa");
      const widthPx = checker.within(outline.widthPx, `${path}.outline.widthPx`, OUTLINE_WIDTH_PX.min, OUTLINE_WIDTH_PX.max, true, true);
      if (typeof text === "string" && HEX_COLOUR.test(text) && widthPx !== null) {
        const channel = (index: number): number => parseInt(text.slice(1 + 2 * index, 3 + 2 * index), 16) / 255;
        style.outline = { color: [channel(0), channel(1), channel(2), text.length > 7 ? channel(3) : 1], widthPx };
      }
    }
  }
  if (record.hover === null) style.hover = null;
  else if (record.hover !== undefined) {
    const hover = checker.record(record.hover, `${path}.hover`);
    if (hover) {
      checker.keys(hover, `${path}.hover`, ["scale"]);
      const scale = checker.within(hover.scale, `${path}.hover.scale`, HOVER_SCALE.min, HOVER_SCALE.max, true, true);
      if (scale !== null) style.hover = scale;
    }
  }
  return style;
}

function resolveMarkerStyle(scene: StyleOverrides, own: StyleOverrides): ResolvedMarkerStyle {
  const outline = own.outline !== undefined ? own.outline : scene.outline ?? null;
  const hover = own.hover !== undefined ? own.hover : scene.hover ?? null;
  return { outline: outline && outline.widthPx > 0 && outline.color[3] > 0 ? outline : null, hoverScale: hover ?? 1 };
}

function checkPanorama(checker: Checker, record: Json, path: string, sceneStyle: StyleOverrides): ResolvedPanorama | null {
  checker.keys(record, path, ["id", "type", "assetId", "title", "description", "capture", "imagePose", "marker", "initialView", "links", "required", "extensions"]);
  const id = checker.id(record.id, `${path}.id`);
  const assetId = checker.id(record.assetId, `${path}.assetId`);
  const title = checker.text(record.title, `${path}.title`);
  const description = record.description === undefined ? undefined : checker.text(record.description, `${path}.description`) ?? undefined;
  if (record.required !== undefined && typeof record.required !== "boolean") checker.fail(`${path}.required`, "must be true or false");

  const captureRecord = checker.record(record.capture, `${path}.capture`);
  let capture: ResolvedPanorama["capture"] | null = null;
  if (captureRecord) {
    checker.keys(captureRecord, `${path}.capture`, ["longitudeDeg", "latitudeDeg", "height", "horizontalAccuracyMeters"]);
    const place = checkLongitudeLatitude(checker, captureRecord, `${path}.capture`);
    const height = checkHeight(checker, captureRecord.height, `${path}.capture.height`);
    const accuracy = captureRecord.horizontalAccuracyMeters === undefined ? undefined : checker.nonNegative(captureRecord.horizontalAccuracyMeters, `${path}.capture.horizontalAccuracyMeters`);
    if (place) capture = { ...place, height: height ?? null, ...(accuracy !== undefined && accuracy !== null ? { horizontalAccuracyMeters: accuracy } : {}) };
  }

  const poseRecord = checker.record(record.imagePose, `${path}.imagePose`);
  let imagePose: ResolvedPanorama["imagePose"] | null = null;
  if (poseRecord) {
    checker.keys(poseRecord, `${path}.imagePose`, ["headingDeg", "pitchDeg", "rollDeg"]);
    const headingDeg = checker.within(poseRecord.headingDeg, `${path}.imagePose.headingDeg`, 0, 360, true, false);
    const pitchDeg = checker.within(poseRecord.pitchDeg, `${path}.imagePose.pitchDeg`, -90, 90, true, true);
    const rollDeg = checker.within(poseRecord.rollDeg, `${path}.imagePose.rollDeg`, -180, 180, false, true);
    if (headingDeg !== null && pitchDeg !== null && rollDeg !== null) imagePose = { headingDeg, pitchDeg, rollDeg };
  }

  const markerRecord = checker.record(record.marker, `${path}.marker`);
  let marker: ResolvedPanorama["marker"] | null = null;
  if (markerRecord) {
    checker.keys(markerRecord, `${path}.marker`, ["mode", "eastM", "northM", "offsetM", "radiusMeters", "style"]);
    const mode = checker.oneOf(markerRecord.mode, `${path}.marker.mode`, ["ground-relative", "capture-relative"] as const);
    const eastM = checker.finite(markerRecord.eastM, `${path}.marker.eastM`);
    const northM = checker.finite(markerRecord.northM, `${path}.marker.northM`);
    const offsetM = checker.finite(markerRecord.offsetM, `${path}.marker.offsetM`);
    let radiusMeters: number | undefined;
    if (markerRecord.radiusMeters !== undefined) {
      const radius = checker.finite(markerRecord.radiusMeters, `${path}.marker.radiusMeters`);
      if (radius !== null && radius <= 0) checker.fail(`${path}.marker.radiusMeters`, "must be positive");
      else if (radius !== null) radiusMeters = radius;
    }
    if (mode === "capture-relative" && capture && !capture.height) {
      checker.fail(`${path}.marker.mode`, "capture-relative placement needs a known capture height; use ground-relative");
    }
    if (mode && eastM !== null && northM !== null && offsetM !== null) marker = { mode, eastM, northM, offsetM, ...(radiusMeters ? { radiusMeters } : {}) };
  }
  const ownStyle = markerRecord?.style === undefined ? {} : checkMarkerStyle(checker, markerRecord.style, `${path}.marker.style`);

  const initialView = record.initialView === undefined ? undefined : checkView(checker, record.initialView, `${path}.initialView`) ?? undefined;
  const links: LinkRecord[] = [];
  if (record.links !== undefined) {
    const seen = new Set<string>();
    (checker.array(record.links, `${path}.links`) ?? []).forEach((entry, index) => {
      const link = checkLink(checker, entry, `${path}.links[${index}]`);
      if (!link) return;
      if (seen.has(link.id)) checker.fail(`${path}.links[${index}].id`, `repeats link id "${link.id}" in this panorama`);
      seen.add(link.id);
      links.push(link);
    });
  }
  const extensions = checker.extensions(record.extensions, `${path}.extensions`);
  if (!id || !assetId || !title || !capture || !imagePose || !marker) return null;
  return {
    id, type: "panorama", assetId, title, ...(description ? { description } : {}), capture, imagePose, marker,
    ...(initialView ? { initialView } : {}), links, markerStyle: resolveMarkerStyle(sceneStyle, ownStyle), ...(record.required === true ? { required: true } : {}),
    ...(Object.keys(extensions).length ? { extensions } : {}),
  };
}

function checkOverview(checker: Checker, value: unknown, path: string): OverviewRecord | null {
  const record = checker.record(value, path);
  if (!record) return null;
  checker.keys(record, path, ["target", "distanceMeters", "headingDeg", "pitchDeg", "verticalFovDeg"]);
  const target = checker.record(record.target, `${path}.target`);
  let place: { longitudeDeg: number; latitudeDeg: number } | null = null;
  let height: HeightRecord | null | undefined;
  if (target) {
    checker.keys(target, `${path}.target`, ["longitudeDeg", "latitudeDeg", "height"]);
    place = checkLongitudeLatitude(checker, target, `${path}.target`);
    height = checkHeight(checker, target.height, `${path}.target.height`);
  }
  const distanceMeters = checker.finite(record.distanceMeters, `${path}.distanceMeters`);
  if (distanceMeters !== null && distanceMeters <= 0) checker.fail(`${path}.distanceMeters`, "must be positive");
  const headingDeg = checker.within(record.headingDeg, `${path}.headingDeg`, 0, 360, true, false);
  const pitchDeg = checker.within(record.pitchDeg, `${path}.pitchDeg`, -90, 90, true, true);
  const verticalFovDeg = checker.within(record.verticalFovDeg, `${path}.verticalFovDeg`, 0, 180, false, false);
  if (!place || distanceMeters === null || distanceMeters <= 0 || headingDeg === null || pitchDeg === null || verticalFovDeg === null) return null;
  return { target: { ...place, height: height ?? null }, distanceMeters, headingDeg, pitchDeg, verticalFovDeg };
}

/** A generous default for pure use; the loader passes the user's `scene.*` limits. */
const DEFAULT_LIMITS: SceneLimits = { manifestBytes: 2 * 1024 * 1024, entities: 2000, assets: 2000, links: 10000 };

/**
 * Validates a complete candidate. `input` is the manifest's text or its
 * parsed JSON. Unknown format versions fail before anything else is read.
 */
export function validateScene(input: unknown, options: ValidateSceneOptions = {}): SceneValidation {
  const limits: SceneLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const checker = new Checker();
  let document: unknown = input;
  let manifestBytes: number;
  if (typeof input === "string") {
    manifestBytes = utf8Bytes(input);
    if (manifestBytes > limits.manifestBytes) {
      return { ok: false, errors: [{ path: "$", message: `the manifest is ${manifestBytes} bytes, over the ${limits.manifestBytes}-byte limit (scene.manifestMiB)` }] };
    }
    try {
      document = JSON.parse(input);
    } catch (error) {
      return { ok: false, errors: [{ path: "$", message: `is not JSON: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  } else {
    manifestBytes = utf8Bytes(JSON.stringify(input) ?? "");
    if (manifestBytes > limits.manifestBytes) {
      return { ok: false, errors: [{ path: "$", message: `the manifest is ${manifestBytes} bytes, over the ${limits.manifestBytes}-byte limit (scene.manifestMiB)` }] };
    }
  }
  const root = checker.record(document, "$");
  if (!root) return { ok: false, errors: checker.errors };
  if (root.format !== SCENE_FORMAT) return { ok: false, errors: [{ path: "$.format", message: `must be "${SCENE_FORMAT}"` }] };
  if (root.version !== SCENE_FORMAT_VERSION) {
    return { ok: false, errors: [{ path: "$.version", message: `version ${JSON.stringify(root.version)} is not supported; this loader reads version ${SCENE_FORMAT_VERSION}, and migrations are explicit tools` }] };
  }
  // Counts before anything else is built.
  const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  if (countOf(root.entities) > limits.entities) checker.fail("$.entities", `has ${countOf(root.entities)} entities, over the limit of ${limits.entities} (scene.entityLimit)`);
  if (countOf(root.assets) > limits.assets) checker.fail("$.assets", `has ${countOf(root.assets)} assets, over the limit of ${limits.assets} (scene.assetLimit)`);
  const linkCount = Array.isArray(root.entities)
    ? root.entities.reduce((sum: number, entity) => sum + (isRecord(entity) && Array.isArray(entity.links) ? entity.links.length : 0), 0)
    : 0;
  if (linkCount > limits.links) checker.fail("$.entities", `has ${linkCount} links, over the limit of ${limits.links} (scene.linkLimit)`);
  if (checker.errors.length) return { ok: false, errors: checker.errors };

  let base: URL | null = null;
  if (options.baseUrl) {
    try { base = new URL(String(options.baseUrl)); } catch { checker.fail("$", `the base URL ${String(options.baseUrl)} is not a URL`); }
  }

  checker.keys(root, "$", ["format", "version", "id", "revision", "title", "requiredExtensions", "extensions", "assets", "entities", "groups", "initialPanorama", "overview", "markerStyle"]);
  const sceneStyle = root.markerStyle === undefined ? {} : checkMarkerStyle(checker, root.markerStyle, "$.markerStyle");
  const id = checker.id(root.id, "$.id");
  const revision = checker.text(root.revision, "$.revision");
  const title = checker.text(root.title, "$.title");
  const extensions = checker.extensions(root.extensions, "$.extensions");
  const supported = new Set(options.supportedExtensions ?? []);
  if (root.requiredExtensions !== undefined) {
    (checker.array(root.requiredExtensions, "$.requiredExtensions") ?? []).forEach((name, index) => {
      const path = `$.requiredExtensions[${index}]`;
      if (typeof name !== "string") checker.fail(path, "must be an extension name");
      else if (!(name in extensions)) checker.fail(path, `names "${name}", which is not a key of "extensions"`);
      else if (!supported.has(name)) checker.fail(path, `requires the extension "${name}", which this loader does not support`);
    });
  }

  const assets = new Map<string, ResolvedAsset>();
  const unsupportedAssets = new Map<string, string>();
  (checker.array(root.assets, "$.assets") ?? []).forEach((entry, index) => {
    const { asset, unsupportedType, id: assetId } = checkAsset(checker, entry, `$.assets[${index}]`, base);
    if (!assetId) return;
    if (assets.has(assetId) || unsupportedAssets.has(assetId)) checker.fail(`$.assets[${index}].id`, `repeats asset id "${assetId}"`);
    if (asset) assets.set(assetId, asset);
    else if (unsupportedType) unsupportedAssets.set(assetId, unsupportedType);
  });

  const panoramas = new Map<string, ResolvedPanorama>();
  const unsupported = new Map<string, UnsupportedEntity>();
  const entityOrder: string[] = [];
  const entityPaths = new Map<string, string>();
  (checker.array(root.entities, "$.entities") ?? []).forEach((entry, index) => {
    const path = `$.entities[${index}]`;
    const record = checker.record(entry, path);
    if (!record) return;
    const entityId = checker.id(record.id, `${path}.id`);
    if (!entityId) return;
    if (entityPaths.has(entityId)) { checker.fail(`${path}.id`, `repeats entity id "${entityId}"`); return; }
    entityPaths.set(entityId, path);
    entityOrder.push(entityId);
    if (record.type !== "panorama") {
      const type = typeof record.type === "string" ? record.type : "(none)";
      if (record.required === true) checker.fail(`${path}.type`, `entity type "${type}" is required but not supported by this loader`);
      else {
        checker.warn(`${path}.type`, `entity type "${type}" is not supported; it is listed but not shown`);
        unsupported.set(entityId, { id: entityId, type, reason: `This loader does not show "${type}" entities.` });
      }
      return;
    }
    const panorama = checkPanorama(checker, record, path, sceneStyle);
    if (!panorama) return;
    if (!assets.has(panorama.assetId)) {
      if (unsupportedAssets.has(panorama.assetId)) {
        const reason = `Its asset "${panorama.assetId}" is a "${unsupportedAssets.get(panorama.assetId)}", which this loader does not show.`;
        if (panorama.required) checker.fail(`${path}.assetId`, reason);
        else unsupported.set(panorama.id, { id: panorama.id, type: "panorama", reason });
        return;
      }
      checker.fail(`${path}.assetId`, `refers to asset "${panorama.assetId}", which the scene does not define`);
      return;
    }
    panoramas.set(panorama.id, panorama);
  });

  for (const panorama of panoramas.values()) {
    const path = entityPaths.get(panorama.id)!;
    panorama.links.forEach((link, index) => {
      if (panoramas.has(link.target)) return;
      if (unsupported.has(link.target)) {
        checker.warn(`${path}.links[${index}].target`, `leads to "${link.target}", which is not supported; the link is listed disabled`);
        return;
      }
      checker.fail(`${path}.links[${index}].target`, `leads to "${link.target}", which is not a panorama in this scene`);
    });
  }

  const groups: GroupRecord[] = [];
  if (root.groups !== undefined) {
    const seen = new Set<string>();
    (checker.array(root.groups, "$.groups") ?? []).forEach((entry, index) => {
      const path = `$.groups[${index}]`;
      const record = checker.record(entry, path);
      if (!record) return;
      checker.keys(record, path, ["id", "title", "members", "extensions"]);
      const groupId = checker.id(record.id, `${path}.id`);
      const groupTitle = checker.text(record.title, `${path}.title`);
      const groupExtensions = checker.extensions(record.extensions, `${path}.extensions`);
      if (groupId && seen.has(groupId)) checker.fail(`${path}.id`, `repeats group id "${groupId}"`);
      if (groupId) seen.add(groupId);
      const members: string[] = [];
      (checker.array(record.members, `${path}.members`) ?? []).forEach((member, memberIndex) => {
        const memberId = checker.id(member, `${path}.members[${memberIndex}]`);
        if (!memberId) return;
        if (!entityPaths.has(memberId)) checker.fail(`${path}.members[${memberIndex}]`, `refers to "${memberId}", which is not an entity of this scene`);
        else if (members.includes(memberId)) checker.fail(`${path}.members[${memberIndex}]`, `lists "${memberId}" twice`);
        else members.push(memberId);
      });
      if (groupId && groupTitle) groups.push({ id: groupId, title: groupTitle, members, ...(Object.keys(groupExtensions).length ? { extensions: groupExtensions } : {}) });
    });
  }

  let initialPanorama: string | null = null;
  if (root.initialPanorama !== undefined) {
    const initial = checker.id(root.initialPanorama, "$.initialPanorama");
    if (initial && !panoramas.has(initial)) checker.fail("$.initialPanorama", `names "${initial}", which is not a supported panorama of this scene`);
    else initialPanorama = initial;
  }
  const overview = root.overview === undefined ? null : checkOverview(checker, root.overview, "$.overview");

  if (checker.errors.length || !id || !revision || !title) return { ok: false, errors: checker.errors };
  return {
    ok: true,
    scene: {
      format: SCENE_FORMAT,
      version: SCENE_FORMAT_VERSION,
      id,
      revision,
      title,
      baseUrl: base?.href ?? null,
      assets,
      panoramas,
      entityOrder,
      unsupported,
      groups,
      initialPanorama,
      overview,
      extensions,
      warnings: checker.warnings,
      manifestBytes,
    },
  };
}
