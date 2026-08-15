import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(new URL(".", import.meta.url)))

// 1. Compile CLI + shared core with tsc (rewrites .ts imports to .js).
const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)

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
