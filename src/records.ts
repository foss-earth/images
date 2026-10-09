import type { ImageDiagnostic, ImageExtensions, ImageRepresentation } from "./contracts.js";

const ID = /^[A-Za-z0-9._-]+$/;
/** An extension key names its owner: `owner.name`, lower-case owner. */
const EXTENSION_KEY = /^[a-z0-9-]+(\.[A-Za-z0-9_-]+)+$/;
const MIME_TYPES = ["image/jpeg", "image/png"] as const;
type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ImageRecordChecker {
  readonly errors: ImageDiagnostic[] = [];
  readonly warnings: ImageDiagnostic[] = [];

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

  nonNegativeInteger(value: unknown, path: string): number | null {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    this.fail(path, "must be a whole number, 0 or more");
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

  extensions(value: unknown, path: string): ImageExtensions {
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

export function resolveImageUrl(checker: ImageRecordChecker, value: unknown, path: string, base: URL | null): string | null {
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

/** Common image fields only; owners validate their own keys and spatial fields. */
export function checkImageRepresentationBase(checker: ImageRecordChecker, record: Record<string, unknown>, path: string): Omit<ImageRepresentation, "projection"> | null {
  const id = checker.id(record.id, `${path}.id`);
  const role = checker.oneOf(record.role, `${path}.role`, ["preview", "immersion"] as const);
  const mimeType = checker.oneOf(record.mimeType, `${path}.mimeType`, MIME_TYPES);
  const encodedBytes = checker.positiveInteger(record.encodedBytes, `${path}.encodedBytes`);
  const extensions = checker.extensions(record.extensions, `${path}.extensions`);
  if (!id || !role || !mimeType || !encodedBytes) return null;
  return { id, role, mimeType, encodedBytes, ...(Object.keys(extensions).length ? { extensions } : {}) };
}
