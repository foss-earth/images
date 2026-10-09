import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The coordinator prepares every archive, including this package and the
// compiler. This harness never packs/resolves source or ancestor dependencies.
const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const required = { "@foss-earth/images": "0.1.0", "@foss-earth/ui": "0.1.0", "jpeg-js": "0.4.4", "typescript": "5.9.3", "@types/node": "24.12.4" };
const closureName = process.env.IMAGES_CONSUMER_ARCHIVES;
assert.ok(closureName, "IMAGES_CONSUMER_ARCHIVES must name a complete exact archive closure JSON; ancestor packing and IMAGES_UI_ARTIFACT are unsupported.");
const closureFile = realpathSync(path.resolve(closureName));
const closure = JSON.parse(readFileSync(closureFile, "utf8"));
assert.equal(closure.version, 1);
assert.ok(Array.isArray(closure.packages) && closure.packages.length > 0);
const supplied = new Map();
for (const record of closure.packages) {
  assert.match(record.name ?? "", /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
  assert.ok(!supplied.has(record.name), `Duplicate closure package: ${record.name}`);
  assert.match(record.version ?? "", /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  assert.match(record.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(record.bytes) && record.bytes > 0);
  assert.equal(typeof record.archive, "string");
  const archive = realpathSync(path.resolve(path.dirname(closureFile), record.archive));
  assert.ok(lstatSync(archive).isFile(), `Archive must be an externally prepared regular file: ${record.name}`);
  const bytes = readFileSync(archive);
  assert.equal(bytes.length, record.bytes, `Archive size: ${record.name}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256, `Archive digest: ${record.name}`);
  supplied.set(record.name, { ...record, archive });
}
for (const [name, version] of Object.entries(required)) assert.equal(supplied.get(name)?.version, version, `Required exact prerequisite: ${name}`);
if (process.argv.includes("--prerequisites-only")) {
  process.stdout.write(JSON.stringify({ status: "archive-prerequisites-validated", packages: [...supplied.keys()], installedOrExecuted: false }) + "\n");
  process.exit(0);
}

const build = path.join(root, "build"), parent = path.join(build, "consumers");
for (const directory of [build, parent]) {
  mkdirSync(directory, { recursive: true });
  assert.equal(realpathSync(directory), directory, "Owner output cannot redirect to another tree.");
}
const output = path.join(parent, new Date().toISOString().replaceAll(/[:.]/g, "-") + `-${process.pid}`);
assert.ok(!existsSync(output), "Each run requires fresh retained output."); mkdirSync(output);
const workspace = path.join(output, "workspace"), temp = path.join(output, "tmp"), cache = path.join(output, "npm-cache"), artifacts = path.join(output, "artifacts");
for (const directory of [workspace, temp, cache, artifacts]) { mkdirSync(directory); assert.equal(realpathSync(directory), directory); }
writeFileSync(path.join(output, "input-closure.json"), JSON.stringify(closure, null, 2) + "\n");
const dependencies = {}, archives = {};
let archiveIndex = 0;
for (const [name, record] of supplied) {
  // Pin the actual copied bytes again before install. Source archives cannot
  // change underneath a run after its initial metadata validation.
  const bytes = readFileSync(record.archive);
  assert.equal(bytes.length, record.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);
  const filename = `${archiveIndex++}-${name.replaceAll(/[^a-zA-Z0-9._-]/g, "-")}-${record.version}.tgz`;
  const archive = path.join(artifacts, filename); writeFileSync(archive, bytes, { flag: "wx" });
  dependencies[name] = `file:${archive}`;
  archives[name] = { version: record.version, sha256: record.sha256, bytes: record.bytes, archive: path.relative(output, archive) };
}
writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "images-installed-fixture", version: "1.0.0", private: true, type: "module", dependencies }, null, 2) + "\n");
const run = (command, argv, log, extraEnv = {}) => {
  const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
  delete env.NODE_PATH; delete env.NODE_OPTIONS; delete env.IMAGES_CONSUMER_PROFILE;
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
  Object.assign(env, extraEnv);
  const filename = path.join(output, log), fd = openSync(filename, "wx"); let result;
  try { result = spawnSync(command, argv, { cwd: workspace, env, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `Consumer interrupted; inspect ${filename}`);
  assert.equal(result.status, 0, `Installed consumer failed; inspect ${filename}`);
  return readFileSync(filename, "utf8");
};
run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache, "--prefix", workspace], "install.log");
const workspaceReal = realpathSync(workspace), confined = filename => {
  const physical = realpathSync(filename);
  assert.ok(physical === workspaceReal || physical.startsWith(workspaceReal + path.sep), `OUTSIDE_ISOLATED_WORKSPACE: ${filename}`);
  return physical;
};
const installed = new Map();
function physicalTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name), physical = confined(filename);
    if (entry.isSymbolicLink()) {
      assert.ok(lstatSync(physical).isFile(), `Package directory/source links are unsupported: ${filename}`);
    } else if (entry.isDirectory()) physicalTree(filename);
  }
}
function inventory(directory, scope = "") {
  confined(directory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
    assert.ok(!entry.name.startsWith("."), `Unqualified hidden package location: ${entry.name}`);
    const candidate = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) { assert.ok(!scope); inventory(candidate, entry.name); continue; }
    assert.ok(!lstatSync(candidate).isSymbolicLink(), "Installed packages cannot be source links.");
    const manifest = JSON.parse(readFileSync(path.join(candidate, "package.json"), "utf8"));
    const name = scope ? `${scope}/${entry.name}` : entry.name, expected = supplied.get(name);
    assert.equal(manifest.name, name, `Archive installed identity: ${name}`);
    assert.ok(expected, `Unpinned transitive package: ${name}`);
    assert.equal(manifest.version, expected.version, `Installed physical version: ${name}`);
    assert.ok(!installed.has(name), `Multiple physical versions are not qualified: ${name}`);
    assert.ok(![manifest.bundleDependencies, manifest.bundledDependencies].some(value => value === true || Array.isArray(value) && value.length > 0), `Bundled dependencies require a separately pinned closure: ${name}`);
    assert.ok(!existsSync(path.join(candidate, "node_modules")), `Nested package locations are unsupported; provide a flat one-version closure: ${name}`);
    physicalTree(candidate);
    installed.set(name, { manifest, directory: confined(candidate) });
  }
}
inventory(path.join(workspace, "node_modules"));
for (const name of supplied.keys()) assert.ok(installed.has(name), `Archive was not physically installed: ${name}`);
for (const [name, { manifest }] of installed) {
  // Optional peers may be absent, but anything physically installed still
  // requires an exact archive pin. Required transitive edges may not escape.
  for (const dependency of Object.keys(manifest.dependencies ?? {})) assert.ok(installed.has(dependency), `Incomplete dependency closure: ${name} -> ${dependency}`);
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) if (!manifest.peerDependenciesMeta?.[peer]?.optional) assert.ok(installed.has(peer), `Incomplete required peer closure: ${name} -> ${peer}`);
}
// npm validates version ranges/peer edges against the installed flat closure.
run("npm", ["ls", "--all", "--json", "--offline", "--cache", cache, "--prefix", workspace], "installed-tree.log");
writeFileSync(path.join(output, "installed-physical.json"), JSON.stringify([...installed].map(([name, item]) => ({ name, version: item.manifest.version, realpath: path.relative(output, item.directory) })), null, 2) + "\n");

const imagePackage = installed.get("@foss-earth/images"), manifest = imagePackage.manifest;
assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./browser", "./node", "./settings", "./shaders"].sort(), "Every advertised entry needs a corresponding fixture.");
const exportTargets = [];
function exportFiles(value) {
  if (typeof value === "string") {
    assert.ok(value.startsWith("./") && !value.includes("*"), "Unsupported export target; add a concrete fixture.");
    const filename = path.resolve(imagePackage.directory, value), physical = confined(filename);
    assert.ok(physical.startsWith(imagePackage.directory + path.sep), `Export target escaped its own installed package: ${value}`);
    const bytes = readFileSync(filename); assert.ok(bytes.length, `Empty export: ${value}`);
    exportTargets.push({ target: value, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  } else if (value && typeof value === "object") for (const child of Object.values(value)) exportFiles(child);
  else assert.fail("Unsupported advertised export condition.");
}
exportFiles(manifest.exports);
writeFileSync(path.join(workspace, "guard-policy.json"), JSON.stringify({
  pure: ["@foss-earth/images"], node: ["@foss-earth/images", "jpeg-js"], settings: ["@foss-earth/images", "@foss-earth/ui"], tools: [...installed.keys()],
}, null, 2));
for (const fixture of ["runtime-guard.mjs", "pure-consumer.mjs", "settings-runtime.mjs", "runtime-negative.mjs", "declaration-guard.mjs", "declaration-negative.mjs"]) {
  writeFileSync(path.join(workspace, fixture), readFileSync(path.join(root, "tests", "consumer", fixture)));
}
writeFileSync(path.join(workspace, "installed-consumer.mjs"), readFileSync(path.join(root, "tests", "installed-consumer.mjs")));
const guarded = (filename, log, profile, argv = []) => run(process.execPath, ["--import", "./runtime-guard.mjs", filename, ...argv], log, { IMAGES_CONSUMER_PROFILE: profile });
for (const entry of ["root", "browser", "shaders"]) guarded("pure-consumer.mjs", `pure-${entry}.log`, "pure", [entry]);
guarded("installed-consumer.mjs", "installed-consumer.log", "node");
guarded("settings-runtime.mjs", "settings-runtime.log", "settings");

// Controlled escape fixtures are retained outside the installed workspace;
// the symlinks specifically defeat a pathname-only containment guard.
writeFileSync(path.join(output, "outside.mjs"), "export const fixture=true;\n");
writeFileSync(path.join(output, "outside-types.d.ts"), "export declare const fixture: unique symbol;\n");
symlinkSync(path.join(output, "outside.mjs"), path.join(workspace, "escape.mjs"));
symlinkSync(path.join(output, "outside-types.d.ts"), path.join(workspace, "escape.d.ts"));
for (const name of ["@foss-earth/ui", "@foss-earth/engine", "react", "jpeg-js"]) {
  const directory = path.join(workspace, "control", "node_modules", name); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "probe.mjs"), "export const fixture=true;\n");
  writeFileSync(path.join(directory, "probe.d.ts"), "export declare const fixture: true;\n");
}
guarded("runtime-negative.mjs", "runtime-negative.log", "pure");

for (const fixture of ["minimal-consumer.ts", "settings-consumer.ts", "node-consumer.ts", "shaders-consumer.ts"]) writeFileSync(path.join(workspace, fixture), readFileSync(path.join(root, "tests", fixture)));
writeFileSync(path.join(workspace, "pure-public.ts"), 'import * as root from "@foss-earth/images";\nimport * as browser from "@foss-earth/images/browser";\nimport * as shaders from "@foss-earth/images/shaders";\nexport const publicPure = [root, browser, shaders];\n');
writeFileSync(path.join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: {
  target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, noEmit: true,
  lib: ["ES2023", "DOM", "DOM.Iterable"], types: ["node"], incremental: true, tsBuildInfoFile: "node_modules/.tmp/consumer.tsbuildinfo",
}, files: ["minimal-consumer.ts", "settings-consumer.ts", "node-consumer.ts", "shaders-consumer.ts"] }, null, 2));
const trace = guarded("node_modules/typescript/bin/tsc", "public-types.log", "tools", ["-p", "tsconfig.json", "--traceResolution"]);
for (const match of trace.matchAll(/successfully resolved to '([^']+)'/g)) confined(match[1]);
guarded("declaration-guard.mjs", "declaration-closure.log", "tools");
writeFileSync(path.join(workspace, "negative-direct.ts"), '/// <reference path="../outside-types.d.ts" />\n');
writeFileSync(path.join(workspace, "negative-symlink.ts"), 'export * from "./escape.js";\n');
writeFileSync(path.join(workspace, "negative-feature.ts"), 'export * from "./control/node_modules/@foss-earth/ui/probe.js";\n');
guarded("declaration-negative.mjs", "declaration-negative.log", "tools");
const receipt = {
  status: "isolated-installed-consumer-passed", package: manifest.name, version: manifest.version, archives, exportTargets,
  installedPhysical: path.relative(root, path.join(output, "installed-physical.json")),
  checks: ["exact externally supplied complete archive closure; no source packing", "fresh offline workspace/cache/temp with sanitized Node/npm environment", "exact installed names/versions/transitive edges and physical paths", "each advertised import/types target confined to its package", "separate pure root/browser/shaders, Node codecs and optional settings scopes", "runtime outside/symlink/pure feature negative controls", "strict full public declarations and physical source-file guard with direct/symlink negative controls", "retained original codec/color/cache/broker/decoded-input assertions plus inferred MIME/HTTP/RGBA/dimensions"],
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  limitations: ["No native/browser/GPU/device or environment-range qualification", "Shared CI conformance/lineage/full refs/actual host adoption/remote admission remain separate", "Single flat exact dependency version per name; incompatible version closures must be reconciled explicitly"],
};
writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify({ output, receipt }) + "\n");
