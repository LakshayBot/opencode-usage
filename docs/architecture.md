# Architecture — opencode-usage

## 1. Integration strategy

A single npm package ships two runtimes plus a CLI:

```
┌─────────────────────────────────────────────────────────────┐
│                    opencode-usage (npm)                      │
│                                                              │
│  CLI (Node ≥ 23.4, node:sqlite)                              │
│    install | uninstall | status | import | stats | reset     │
│    update-pricing                                            │
│                                                              │
│  Server plugin (bundled .js, loaded by opencode/Bun)         │
│    event() → capture usage → write global SQLite (async)     │
│    tool "usage" → report generator for the LLM path          │
│    command.execute.before → fast-path interception           │
│                                                              │
│  TUI plugin (bundled, same file)                             │
│    /usage slash command → native dialog popup                │
└─────────────────────────────────────────────────────────────┘
        │                        │                     │
        │ installs files         │ reads/writes        │ reads (import)
        ▼                        ▼                     ▼
~/.config/opencode/       ~/.local/share/         ~/.local/share/
  plugin/opencode-usage.js  opencode-usage/usage.db   opencode/opencode.db
```

- **Server plugin** — the officially supported plugin mechanism (auto-discovered global plugin directory). It captures usage from **opencode's own normalized event stream** (`message.part.updated` with `step-finish` parts), which contains exact tokens + cost computed by opencode itself — no estimation ever.
- **TUI plugin**: same installation, second export. Registers `/usage` in the TUI command palette; selecting it opens a **native dialog popup** (via `api.ui.dialog` + `api.ui.DialogSelect` — the same mechanism as the theme/model selectors), so the backdrop, widths, theming and Esc handling come from the host. Zero LLM tokens consumed for the primary path. (Loaded via the `tui.json` `plugin` array — see §6.)
- **CLI** — operations tooling (install/uninstall/status/import/stats/reset/update-pricing).

## 2. Event lifecycle (capture)

Per opencode server instance (one per project directory):

```
LLM step finishes
  → opencode normalizes usage (AI SDK v6) → Session.getUsage() → cost + tokens
  → updatePart(step-finish) → bus event "message.part.updated" { sessionID, part, time }
  → updateMessage(assistant) → bus event "message.updated" { sessionID, info }
  → session.touch/update → bus event "session.updated" { sessionID, info }

our plugin.event() sees:
  message.part.updated  (part.type === "step-finish")  → insert UsageEvent
  message.updated       (info.role === "assistant")    → remember model/provider/agent per messageID
  message.updated       (info.role === "user")         → count user message (or chat.message hook)
  session.created       → insert session row (parentID ⇒ subagent)
  session.updated       → refresh session row last-activity
```

Attribution map: `messageID → { modelID, providerID, agent }` maintained in memory from `message.updated` events; `step-finish` parts carry `messageID`, so every event is attributed to the exact model/provider/agent. Child (subagent) sessions identified via `session.parentID`; agent name from message `agent` field.

All writes go through a **single async worker queue** (in-process `Queue`): event handling returns immediately; the queue drains to SQLite. If the DB is locked, retry with bounded backoff (busy_timeout + N retries). Any failure is caught, logged via `client.app.log`, and **never** propagated — tracking can never break opencode.

## 3. Storage design

SQLite, zero-server, at `~/.local/share/opencode-usage/usage.db` (mirrors opencode's own data-dir convention; `%LOCALAPPDATA%\opencode-usage\usage.db` on Windows).

Driver choice (empirically verified against opencode 1.18.18's bundled Bun):

- **opencode's Bun runtime does NOT implement `node:sqlite`** ("No such built-in module" — verified live), and rejects the options-object form of `bun:sqlite`'s constructor ("flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE"). It *does* support the string-flag form of `bun:sqlite`.
- **Server/TUI plugins run inside opencode's Bun process** → `bun:sqlite` (`Database`), opened with `"rw"` / `"r"` flags. Bun's `"r"` does not enforce read-only, so read-only is enforced in-process by the driver wrapper.
- **CLI runs on Node** → `node:sqlite` (stable on Node ≥ 23.4; feature-detected with a clear error on older Node).
- One driver abstraction (`src/storage/sql-driver.ts`) selects the right backend at module load (`typeof Bun !== "undefined"`). The whole package stays **zero-dependency** — crucial for `npm install -g` / `npx` / `pnpm dlx` portability.

Schema (migration-managed):

```sql
CREATE TABLE usage_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key       TEXT NOT NULL UNIQUE,          -- dedup key
  timestamp       INTEGER NOT NULL,
  session_id      TEXT NOT NULL,
  project_id      TEXT,
  parent_session_id TEXT,                        -- subagent detection
  agent           TEXT,
  provider        TEXT,
  model           TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  cost            REAL,                          -- exact, from opencode (may be NULL)
  estimated_input_cost       REAL,
  estimated_output_cost      REAL,
  estimated_cache_read_cost  REAL,
  estimated_cache_write_cost REAL,
  estimated_total_cost       REAL,
  provider_reported_cache BOOLEAN DEFAULT 0,     -- distinguishes "0" from "not available"
  metadata_json   TEXT
);
CREATE INDEX idx_events_timestamp ON usage_events(timestamp);
CREATE INDEX idx_events_session   ON usage_events(session_id);
CREATE INDEX idx_events_provider  ON usage_events(provider);
CREATE INDEX idx_events_model     ON usage_events(model);
CREATE INDEX idx_events_project   ON usage_events(project_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, agent TEXT,
  created INTEGER, updated INTEGER, title TEXT
);

CREATE TABLE pricing_history (
  id INTEGER PRIMARY KEY, provider TEXT, model TEXT,
  input_per_million REAL, output_per_million REAL,
  cache_read_per_million REAL, cache_write_per_million REAL,
  effective_from INTEGER, effective_until INTEGER, source TEXT,
  UNIQUE(provider, model, effective_from)
);

CREATE TABLE tracking_metadata (key TEXT PRIMARY KEY, value TEXT);
```

- `event_key` = `step-finish part.id` (globally unique in opencode) — duplicate retries, replays, and re-delivered events are naturally idempotent. Historical import reuses the same key (`opencode-usage:import:<part-id>` namespaced per source).
- WAL mode + `busy_timeout` + batching (inserts grouped, transaction per batch). Millions of rows: fine for SQLite with proper indexes.
- Migrations: numbered `user_version`-tracked steps; never destructive; upgrade path documented.

Cost attribution per event:
- `cost` column = the **exact estimated cost computed by opencode at the time of use** (authoritative, includes then-current pricing and provider quirks like Copilot nano-AIU). This is the primary cost signal.
- `estimated_*` columns = component breakdown recomputed by our pricing engine (input/output/cache-read/cache-write at *current* catalog prices), always labeled ESTIMATED, and `NULL` when no price exists (rendered as "Cost: Unknown").

## 4. Deduplication strategy

- In-flight dedup: a `Set` of recently seen `event_key`s per process (bounded, LRU).
- Persisted dedup: `UNIQUE(event_key)` + `INSERT OR IGNORE`.
- Retries: opencode re-runs a failed step with new part IDs → new event keys (correct — they are distinct model calls). Re-emission of the same part (session replay/load) reuses the same part.id → ignored.
- Import: `event_key = "oc:" + part.id`; re-running import is idempotent and reports `already imported` counts.

## 5. Pricing strategy

- **Primary**: opencode's own per-step `cost` (models.dev pricing applied at time of use). This handles historical pricing correctly by construction.
- **Breakdown**: `PricingProvider` interface + `pricing-catalog.ts` (bundled, maintained JSON: Anthropic, OpenAI, Google/Gemini, DeepSeek, Mistral, xAI, Groq, OpenRouter pass-through, etc.) + `opencode-usage update-pricing` to refresh from models.dev (`https://models.dev/api.json` — the same source opencode uses) into `pricing_history` with `effective_from` timestamps.
- `cost-calculator.ts` implements exactly the user-specified formulas (per-1M). Reasoning tokens are charged at output price (matching opencode's documented behavior).
- Models without catalog entries → breakdown columns NULL → "Cost: Unknown". No invented prices, ever.
- `ModelPricing` record supports `effectiveFrom/effectiveUntil` so future catalog updates can price history accurately.

## 6. Installation mechanism (`opencode-usage install`) — empirically verified on 1.18.18

Empirical tests (isolated `OPENCODE_CONFIG_DIR` + fake HOME on the real binary) established exactly which mechanisms load what:

| Mechanism | Server plugin | TUI plugin | Command |
|---|---|---|---|
| `~/.config/opencode/plugin/*.js` dir scan | ✅ loads | ❌ ignored | — |
| `opencode.json` `plugin` array | ✅ | ❌ ignored | — |
| `tui.json` `plugin` array | ❌ | ✅ loads | — |
| `~/.config/opencode/commands/*.md` | — | — | ✅ loads |
| `plugin:` + `file://` absolute path specs | ✅ | ✅ | — |

(The TUI runtime reads a separate config stream — `tui.json`/`tui.jsonc` only — and never scans the plugin directory. A plugin module may export `server` OR `tui`, not both.)

So `opencode-usage install` performs exactly these steps, each idempotent:

1. **Detect opencode**: `opencode --version` via PATH, `~/.opencode/bin/opencode`, `~/.local/share/opencode/bin`; non-fatal.
2. **Resolve global config dir** (xdg-basedir semantics + `OPENCODE_CONFIG_DIR` override): `~/.config/opencode` (macOS/Linux) / `%APPDATA%\opencode` (Windows).
3. **Server plugin**: copy bundled self-contained `dist/plugin-server.js` → `<config>/plugin/opencode-usage.js` (marker comment header `// opencode-usage:installed:vX`). Auto-discovered by the server runtime. `opencode.json` untouched.
4. **TUI plugin**: copy bundled `dist/plugin-tui.js` → `<config>/opencode-usage.tui.js` (NOT in `plugin/`, so the server runtime never tries it). Ensure the global `<config>/tui.json` has a `plugin` array containing `file://<abs>/opencode-usage.tui.js`. If `tui.json` does not exist, create it (a new file — zero risk to existing config). If it exists, parse as JSON and merge ONLY the `plugin` array (dedupe by URL); fail with a clear manual-instruction message if it is unparseable, and complete the rest of the install.
5. **No global command file**: `/usage` lives in the TUI plugin as a native popup. A previous version wrote `<config>/commands/usage.md`; `install` now deletes it if we own it (marker check), so upgrades heal old installs and the palette shows a single `/usage`. (opencode's slash autocomplete merges keymap slash commands and server commands without dedup, so `/usage` must exist in exactly one of them.)
6. **Create/initialize the database** at `<data-dir>/opencode-usage/usage.db` (run migrations).
7. `opencode-usage uninstall` removes ONLY the three files we own (verified via marker header / exact content) and the `tui.json` entry (if the file becomes empty, remove the file; otherwise preserve everything else). DB is kept; `uninstall --purge` deletes the DB after confirmation.

## 7. The `/usage` command (TUI + server duality)

- **TUI plugin**: registers the palette commands `/usage`, `/usage today|week|month|all`. Selecting one runs `openUsage()` → `api.ui.dialog.replace(...)` opens a **native dialog popup** (dimmed backdrop, `backgroundPanel`, medium/large widths, Esc/ctrl+c close — all from the host). The popup renders a compact **Overview** (messages/tokens/cost + input/output/cache breakdown, themed via `api.theme.current`) with a navigable **By model · By provider · History** action list. `↑↓`/`Enter` reuse the `dialog.select` keybindings; "By model" and "By provider" are native `DialogSelect` lists; "History" switches the time period. **Zero LLM cost, and identical in every model** — the report never lands in the chat. All TUI formatting is centralized in `ui/usage/usage-format.ts` and view models in `ui/usage/usage-view-model.ts` — the popup never touches raw rows.
- **No server command file** — and deliberately so. opencode's slash autocomplete (`packages/tui/src/component/prompt/autocomplete.tsx`) merges keymap slashName commands and every server command **without dedup**, so a `commands/usage.md` file plus the keymap `slashName: "usage"` produced two `/usage` palette entries on 1.18.18; keeping only the server command file turned `/usage` into a model call and rendered the report as a chat message (a "prompt", not a preview). `install` removes a leftover `usage.md` from older versions. The `usage` tool stays registered by the server plugin, so typing `/usage ...` + Enter can still produce a report when the model calls the tool (best-effort, one small LLM call).
- Shared reporting core: `reporting/usage-report.ts` + formatters produce both the markdown (tool/LLM path) and the data consumed by the TUI view models. One computation, two renderers.
- Filters: `session` (default), `today`, `week`, `month`, `all`; `model <id>`, `provider <id>`; combined (`/usage week model claude-sonnet`).

## 8. Historical import (`opencode-usage import`)

1. Read-only open `~/.local/share/opencode/opencode.db`.
2. Stream the `part` table, parse JSON `data`, select `type === "step-finish"` → tokens + cost.
3. Look up `message` JSON `data` for `modelID`/`providerID`/`agent` (batch map session → messages).
4. Read `session` table for project/session metadata (`parent_id` → subagent, `time_created/updated`).
5. `INSERT OR IGNORE` with `event_key = "oc:" + part.id`; counts reported: `found sessions / usage events discovered / already imported / new imported`.
6. Only reliable fields are imported; raw metadata stored as-is; unknown values → NULL.

## 9. Failure handling & reliability

- Async queue, fire-and-forget with try/catch — tracking failures can never affect opencode.
- SQLite `busy_timeout=5000`, WAL; on lock → bounded retry, then drop event with warning log (never crash).
- Events are only ever written once (unique key); interrupted processes leave WAL-consistent state (SQLite guarantees); pending in-memory events lost on SIGKILL are acceptable (next `import` can backfill from opencode.db).
- CLI `reset` requires interactive confirmation unless `--yes`.
- Everything labeled ESTIMATED unless it originates from opencode's exact `cost` field (which itself is an estimate of provider billing — documented as such).

## 10. Tech & structure

Zero-dependency TypeScript package. Compiled with `tsc` for the CLI; the plugin file is bundled to a single self-contained `.js` (esbuild/bun build) with no external imports (uses `node:sqlite`, `zod`-free hand-rolled validation for the bundle).

```
src/
  cli/            install.ts uninstall.ts status.ts import.ts stats.ts reset.ts update-pricing.ts index.ts
  plugin/         server-plugin.ts tui-plugin.ts tracker.ts (shared core, bundled)
  tracker/        usage-tracker.ts event-normalizer.ts event-deduplicator.ts
  storage/        database.ts migrations/ repositories/
  pricing/        pricing-provider.ts pricing-catalog.ts cost-calculator.ts modelsdev.ts
  opencode/       paths.ts detector.ts installer.ts command-file.ts historical-importer.ts
  reporting/      usage-report.ts formatters/
  ui/usage/       usage-format.ts usage-view-model.ts usage-view.tsx
                  usage-overview.tsx usage-views.tsx usage-overlay.tsx (TUI popup)
  types/          usage.ts pricing.ts
tests/            unit + integration (tmp-dir based, fake opencode.db fixtures)
```

Test coverage per spec: normalization, provider formats, missing cache, zero-token, duplicates, retries, migrations, pricing, historical pricing, CLI install/uninstall safety, import idempotency, Windows/Linux/macOS paths (env-stubbed), plus an end-to-end test that loads the plugin file with a real opencode event payload and verifies DB rows.
