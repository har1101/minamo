// Builds minamo itself, then bundles src/handler.ts -> dist/index.mjs (AWS SDK included, so the version is pinned).
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("npm", ["run", "build"], { cwd: join(root, "..", ".."), stdio: "inherit" });
await rm(join(root, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [join(root, "src", "handler.ts")],
  outfile: join(root, "dist", "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // `minamo` is a symlink to ../..; point its SDK import at this example's copy, so the SDK is bundled once.
  // Alias the ESM entry: the package directory resolves to the CommonJS build, which uses __filename.
  alias: { "@aws/durable-execution-sdk-js": join(root, "node_modules", "@aws", "durable-execution-sdk-js", "dist", "index.mjs") },
  // Some bundled CommonJS dependencies call require() for Node built-ins.
  banner: { js: "import { createRequire as __bannerCreateRequire } from 'node:module'; const require = __bannerCreateRequire(import.meta.url);" },
  logLevel: "info",
});
