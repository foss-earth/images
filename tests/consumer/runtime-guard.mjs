import { registerHooks } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspace = realpathSync(process.cwd());
const policy = JSON.parse(readFileSync(path.join(workspace, "guard-policy.json"), "utf8"));
const allowed = new Set(policy[process.env.IMAGES_CONSUMER_PROFILE]);
if (!allowed.size) throw new Error("MISSING_CONSUMER_GUARD_PROFILE");
function check(url) {
  if (url.startsWith("node:")) return;
  if (!url.startsWith("file:")) throw new Error("UNSUPPORTED_MODULE_PROTOCOL");
  const physical = realpathSync(fileURLToPath(url));
  if (physical !== workspace && !physical.startsWith(workspace + path.sep)) throw new Error("OUTSIDE_ISOLATED_WORKSPACE");
  const parts = path.relative(workspace, physical).split(path.sep);
  for (let at = 0; at < parts.length; at++) if (parts[at] === "node_modules") {
    const first = parts[at + 1], name = first?.startsWith("@") ? `${first}/${parts[at + 2]}` : first;
    if (!allowed.has(name)) throw new Error(`PURE_IMPORTED_PEER: ${name}`);
  }
}
registerHooks({
  resolve(specifier, context, next) { const result = next(specifier, context); check(result.url); return result; },
  load(url, context, next) { check(url); return next(url, context); },
});
