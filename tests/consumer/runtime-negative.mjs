import assert from "node:assert/strict";
await assert.rejects(import("../outside.mjs"), /OUTSIDE_ISOLATED_WORKSPACE/);
await assert.rejects(import("./escape.mjs"), /OUTSIDE_ISOLATED_WORKSPACE/);
for (const name of ["@foss-earth/ui", "@foss-earth/engine", "react", "jpeg-js"]) await assert.rejects(import(`./control/node_modules/${name}/probe.mjs`), /PURE_IMPORTED_PEER/);
console.log("Direct and symlink runtime escapes and synthetic pure feature/codec imports rejected.");
