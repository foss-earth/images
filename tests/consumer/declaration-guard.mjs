import ts from "typescript";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";

export function confinedDeclarations(program, allowedPackages = null) {
  const root = realpathSync(process.cwd());
  for (const file of program.getSourceFiles()) {
    const physical = realpathSync(file.fileName);
    assert.ok(physical === root || physical.startsWith(root + path.sep), "DECLARATION_OUTSIDE_WORKSPACE");
    if (allowedPackages) {
      const parts = path.relative(root, physical).split(path.sep);
      for (let at = 0; at < parts.length; at++) if (parts[at] === "node_modules") {
        const first = parts[at + 1], name = first?.startsWith("@") ? `${first}/${parts[at + 2]}` : first;
        assert.ok(allowedPackages.has(name), `PURE_DECLARATION_IMPORTED_PEER: ${name}`);
      }
    }
  }
}
if (process.argv[1] === path.join(process.cwd(), "declaration-guard.mjs")) {
  const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile); assert.ok(!config.error);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()); assert.equal(parsed.errors.length, 0);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  confinedDeclarations(program);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
  // Browser/root/shader declarations must not acquire UI or feature peers;
  // this includes indirect type references, beyond runtime import hooks.
  const pureProgram = ts.createProgram(["pure-public.ts"], { ...parsed.options, types: [], tsBuildInfoFile: path.join(process.cwd(), "node_modules/.tmp/pure-consumer.tsbuildinfo") });
  confinedDeclarations(pureProgram, new Set(["@foss-earth/images", "typescript"]));
  assert.equal(ts.getPreEmitDiagnostics(pureProgram).length, 0);
  console.log(`Every ${program.getSourceFiles().length} public fixture/library/dependency source file is physically isolated.`);
}
