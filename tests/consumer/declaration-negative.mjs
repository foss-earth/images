import ts from "typescript";
import assert from "node:assert/strict";
import { confinedDeclarations } from "./declaration-guard.mjs";
for (const filename of ["negative-direct.ts", "negative-symlink.ts"]) {
  const program = ts.createProgram([filename], { noEmit: true, types: [], module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  assert.throws(() => confinedDeclarations(program), /DECLARATION_OUTSIDE_WORKSPACE/);
}
const peerProgram = ts.createProgram(["negative-feature.ts"], { noEmit: true, types: [], module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
assert.throws(() => confinedDeclarations(peerProgram, new Set(["@foss-earth/images", "typescript"])), /PURE_DECLARATION_IMPORTED_PEER/);
console.log("Direct and symlink declaration escapes rejected by the same full-program physical guard.");
