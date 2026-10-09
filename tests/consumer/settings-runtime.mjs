import assert from "node:assert/strict";
for (const name of ["document", "window", "navigator", "localStorage"]) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`Eager browser access: ${name}`); } });
const { createImageResourceParameters, IMAGE_RESOURCE_SECTION_TITLES } = await import("@foss-earth/images/settings");
// Retained original installed-consumer assertion, in its optional UI scope.
assert.equal(createImageResourceParameters({ keptGpuDefault: () => ({ value: 0, derivedFrom: "host" }) }).length, 14);
const { createSettingsRegistry } = await import("@foss-earth/ui/settings");
const settings = createSettingsRegistry({ storage: null });
settings.register(createImageResourceParameters({ keptGpuDefault: () => ({ value: 0, derivedFrom: "host" }) }));
assert.equal(typeof settings.get("scene.panorama.savedMiB"), "number");
assert.ok(IMAGE_RESOURCE_SECTION_TITLES);
console.log("Installed optional settings and exact public UI registry import without ambient DOM/storage access.");
