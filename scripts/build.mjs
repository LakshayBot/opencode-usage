import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(new URL(".", import.meta.url)))

// 0. Version drift guard: package.json version must match src/version.ts.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const versionSrc = fs
  .readFileSync(path.join(root, "src/version.ts"), "utf8")
  .match(/export const VERSION = "([^"]+)"/)?.[1]
if (!versionSrc) throw new Error("src/version.ts is missing the VERSION constant")
if (pkg.version !== versionSrc) {
  throw new Error(`Version drift: package.json is ${pkg.version} but src/version.ts is ${versionSrc} — bump both together`)
}

// 1. Compile CLI + shared core with tsc (rewrites .ts imports to .js).
const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)

// 1b. Typecheck the TUI plugin sources too (jsx/tsx included) — the plugin
// bundles are built by esbuild without typechecking, so without this pass
// type errors in the popup (e.g. calling a signal that became a plain value)
// would only surface as a runtime crash inside opencode.
const tscTui = spawnSync("npx", ["tsc", "-p", "tsconfig.tui.json"], { cwd: root, stdio: "inherit" })
if (tscTui.status !== 0) process.exit(tscTui.status ?? 1)

const external = [
  "node:sqlite",
  "node:*",
  "bun:sqlite",
  "bun:*",
  "solid-js",
  "solid-js/store",
  "@opentui/solid",
  "@opentui/solid/*",
  "@opentui/core",
  "@opentui/keymap",
  "@opentui/keymap/*",
  "@opencode-ai/plugin",
  "@opencode-ai/plugin/*",
]

// 2. Server plugin bundle — self-contained.
await build({
  entryPoints: [path.join(root, "src/plugin/server-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node23",
  external,
  outfile: path.join(root, "dist/plugin/plugin-server.js"),
  legalComments: "none",
  logLevel: "info",
})

// 3. TUI plugin bundle — self-contained, JSX via @opentui/solid.
await build({
  entryPoints: [path.join(root, "src/plugin/tui-entry.tsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node23",
  external,
  jsx: "automatic",
  jsxImportSource: "@opentui/solid",
  outfile: path.join(root, "dist/plugin/plugin-tui.js"),
  legalComments: "none",
  logLevel: "info",
})

// 4. Executable bit for the CLI entry.
fs.chmodSync(path.join(root, "dist/cli/index.js"), 0o755)

console.log("build complete")
