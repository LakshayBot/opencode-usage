# OpenCode Usage

[![npm](https://img.shields.io/npm/v/@skinnysheep/opencode-usage)](https://www.npmjs.com/package/@skinnysheep/opencode-usage)
[![GitHub](https://img.shields.io/badge/source-github-181717?logo=github)](https://github.com/LakshayBot/opencode-usage)
[![GitHub stars](https://img.shields.io/github/stars/LakshayBot/opencode-usage?style=social)](https://github.com/LakshayBot/opencode-usage)

**⭐ Like this plugin? Star the repo — it helps others discover it.**

Track your **OpenCode** token usage, cache statistics and estimated costs — across **all** your projects, from one global database — in a native OpenCode popup with graphs, drill-downs and spend budgets.

```
/usage
```

```
┌ Usage                                              esc ┐
│ Session · Today · Week · Month · All                     │
│ vs prev: +12% req · +8% tokens                           │
│ Budget  $1.20 of $2.00 (60%)                             │
│                                                          │
│ Messages          142      Input               32.4K    │
│ Tokens           48.6K     Output               8.2K    │
│ Cost              $0.07    Reasoning            1.1K    │
│                            Cache Read           7.8K    │
│                            Cache Write          223     │
│ ─────────────────────────────────────────────────────    │
│    By model · By provider · By agent · By project        │
│    By session · Graph · History                          │
│                                                          │
│ ↑↓ navigate · ←→ period · enter open · esc close         │
└──────────────────────────────────────────────────────────┘
```

Zero LLM tokens, theme-aware, Esc to close — the same dialog system behind
OpenCode's theme and model selectors.

## Installation

Requires **Node.js >= 23.4** for the CLI (the plugin itself runs inside opencode's bundled Bun runtime — nothing extra to install).

```bash
npm install -g @skinnysheep/opencode-usage
```

That's it — **global installs run the integration automatically** (a `postinstall`
hook performs the same idempotent `install` as `opencode-usage install`), so you
don't need a second command. Just restart opencode (or start a new session) and
select `/usage` in the palette — the native popup opens in any project.

- Only global installs trigger it; installing the package as a regular
  dependency never touches your config.
- Upgrades re-run it, so fixes/improvements apply on the next `npm update -g`.
- Disable it with `OPENCODE_USAGE_AUTO_INSTALL=0` (or `npm i -g --ignore-scripts`) and run
  `opencode-usage install` whenever you want.
- Some hardened npm setups block lifecycle scripts entirely (`allow-scripts`
  policies). The package still installs fine — just run `opencode-usage install`
  once afterwards. Every CLI command compares the deployed plugin files against
  the package version and prints an explicit reminder until they are current,
  so a silently-skipped postinstall can never go unnoticed.

### Install what it does

| Step | Where | Mechanism |
|---|---|---|
| Server plugin (captures usage + registers the `usage` tool) | `~/.config/opencode/plugin/opencode-usage.js` | auto-discovered plugin directory |
| TUI plugin (native `/usage` popup) | `~/.config/opencode/opencode-usage.tui.js` + entry in `tui.json` | official TUI plugin loading |
| Tracking database | `~/.local/share/opencode-usage/usage.db` | SQLite (WAL) |

No global command file is installed: `/usage` lives in the TUI plugin as a native
popup. (opencode's slash palette lists keymap commands *and* server commands
without dedup, so `/usage` must exist in exactly one place — and a command file
would render the report as a chat message instead of a popup.) If a previous
version left `commands/usage.md`, `install` removes it.

On Windows these live under the home-dir XDG paths too — `C:\Users\you\.config\opencode\...` and `C:\Users\you\.local\share\opencode-usage\usage.db` — matching how current opencode builds resolve paths on Windows (several 1.18.x builds do **not** use `%APPDATA%`). The installer **probes** for whichever directory holds a live opencode install (an existing `opencode.json` / `opencode.db`) and installs there; on a fresh machine it defaults to the home XDG paths. `$OPENCODE_CONFIG_DIR` and `$XDG_CONFIG_HOME`/`$XDG_DATA_HOME` still override everything.

Your existing `opencode.json` is **never modified**. `install` is **idempotent** — safe to run any number of times.

## The popup

The slash palette shows **exactly one entry**: `/usage`. Opened from inside a
session it defaults to that session; from the home screen it defaults to today.

| Keys | Action |
|---|---|
| `←` `→` | Switch period tab (Session · Today · Week · Month · All) |
| `↑` `↓` | Navigate the action list |
| `Enter` | Open the highlighted view |
| `Backspace` / `←` | Back (detail views) |
| `Esc` / `Ctrl+C` | Close |

**Overview** — primary summary (Messages / Tokens / Cost), full breakdown
(Input / Output / Reasoning / Cache Read / Cache Write / Cache Hit), a
`vs prev` comparison against the previous period (hidden for Session/All), and
optional budget lines (see [Budgets](#budgets)).

**Graph** — tokens over time as Unicode bar charts. Hourly buckets for
Session/Today, daily for Week/Month/All. The axis hugs your data (empty edges
trimmed), long ranges fold into daily rows, and the list scrolls inside a
bounded popup (`↑`/`↓`). `←`/`→` flips the bars between token volume and dollar
cost. Bucket costs use current pricing when known and otherwise fall back to
the exact at-use cost opencode recorded; the cost column hides entirely when
neither exists.

**Drill-downs** — `By model`, `By provider`, `By agent`, `By project` and
`By session` open native searchable lists (the same selector OpenCode uses for
themes/models) with per-row tokens, requests and cost. Selecting a model opens
a compact detail view; `Backspace` goes back.

**History** — every period side by side (requests · tokens · cost); selecting
one re-opens the overview in that period.

## Budgets

Optional daily/monthly spend limits, shown on the overview with ok/warn/over
coloring. Create `~/.config/opencode-usage/budgets.json` (USD):

```json
{ "daily": 2, "monthly": 30, "warnAt": 0.8 }
```

- Every field is optional; an absent or malformed file disables budgets
  entirely (the feature never creates state of its own).
- `warnAt` is the fraction of the budget where a line flips from ok to warn
  (default `0.8`); invalid entries are ignored one by one.

## CLI

```
opencode-usage install              Install the global integration
opencode-usage uninstall            Remove it (usage history kept)
opencode-usage uninstall --purge    ...and delete the database (confirms)
opencode-usage status               Installation + tracking status
opencode-usage stats [period]       Print a report (session|today|week|month|all)
opencode-usage stats --json         Machine-readable report
opencode-usage export [--csv|--json] [period] [--out <file>]
                                    Dump daily buckets + per-model rows
opencode-usage import               Import history from opencode's own database
opencode-usage update-pricing       Sync model pricing from models.dev
opencode-usage reset [--yes]        Wipe usage history (interactive confirm)
```

`export` reads from the same reporting layer as `stats` (daily buckets +
per-model rows), defaults to `--json` on stdout, and writes to `--out <file>`
when given — handy for spreadsheets, scripts and dashboards.

`import` is optional but recommended once after `install` — it backfills history that
predates tracking, straight from `~/.local/share/opencode/opencode.db` (read-only,
deduplicated by opencode's stable part IDs):

```
Found sessions:         234
Usage events discovered: 18,492
Already imported:       15,000
New events imported:     3,492
```

Every command also checks the npm registry for newer releases (cached for 24h,
silent on failure — it can never block or break a command) and prints how to
update when one exists. Set `OPENCODE_USAGE_NO_UPDATE_CHECK=1` to disable.

## What data is tracked

For **every model request** (opencode emits a `step-finish` part per LLM step —
tool loops, retries and subagent calls included):

- timestamp, session id, project id, agent (main/subagent/system)
- provider, model
- input tokens, output tokens, reasoning tokens
- cache read tokens, cache write tokens (when the provider reports them)
- total tokens
- **cost as computed by opencode at the time of use** (models.dev pricing)

Plus: one row per user/assistant message (for message counting) and one row per
session. Raw parts are kept in `metadata_json` for auditing.

Tracking is **exact**: tokens and cost come from opencode's own normalized
provider metadata — never estimated by token counting.

## Where data is stored

- Database: `~/.local/share/opencode-usage/usage.db` (Linux/macOS); on Windows the
  same home XDG location `C:\Users\you\.local\share\opencode-usage\usage.db` (probed, see Install)
- SQLite, WAL mode, schema-versioned migrations (forward-only, never destructive)
- Every project on the machine writes into this one shared database

## How costs are calculated

- **Primary**: opencode's per-step `cost` field — the estimated cost computed
  with models.dev pricing **at the time of use**. This is authoritative and
  correct even when prices change later.
- **Breakdown**: input/output/cache-read/cache-write components are recomputed
  from the stored token counts using the best pricing available now
  (models.dev-synced rows first, then the bundled catalog):

```
inputCost     = inputTokens     / 1M * inputPricePerMillion
outputCost    = (output + reasoning) / 1M * outputPricePerMillion
cacheReadCost = cacheReadTokens / 1M * cacheReadPricePerMillion
cacheWriteCost= cacheWriteTokens/ 1M * cacheWritePricePerMillion
```

- The **graph** uses the recomputed breakdown when current pricing exists and
  otherwise falls back to the recorded at-use cost — a bucket is unknown only
  when an event has neither. Run `opencode-usage update-pricing` once to
  extend coverage to everything models.dev lists.
- Reasoning tokens are charged at the output rate (matches opencode's behavior).
- Models with no known pricing show **`Cost: Unknown`** — prices are never invented.
- **Everything is labeled ESTIMATED.** Actual billing can differ (promotions,
  enterprise agreements, provider-side changes).

## Cache hit calculation

Cache hit rate is computed only over requests from providers known to report
cache tokens (Anthropic, OpenAI, Google, DeepSeek, Bedrock, Vertex, …):

```
cache hit rate = cache_read_tokens / (cache_read_tokens + non-cached input tokens)
```

Per-request definition (documented in `docs/architecture.md`): the share of
prompt tokens served from cache in each request. When no cache-reporting
provider is involved, the report shows **`Cache data: Not available`** —
missing cache data is never treated as zero.

## Supported providers

Any provider opencode supports, including models.dev-listed custom providers.
Pricing coverage: see `src/pricing/pricing-catalog.ts` (Anthropic, OpenAI,
Google, DeepSeek, Mistral, xAI, Groq, OpenRouter pass-through). `update-pricing`
extends coverage with everything models.dev lists.

## Reliability

- Writes are async (batched, transactional) — tracking can never slow down or
  break opencode; failures are logged and dropped, never thrown.
- Deduplication: primary keys on stable opencode IDs (part IDs, message IDs);
  re-emitted events (session replay) and re-runs of `import` are no-ops.
- SQLite busy_timeout + bounded retries handle concurrent access.
- The popup renders synchronously and never throws: empty databases, missing
  pricing and unreadable state render as clean in-popup states.

## Privacy

- All data stays on your machine in `~/.local/share/opencode-usage/`.
- Only usage metadata is stored — **no message content** is ever written.
- Raw provider metadata (usage objects) is retained in `metadata_json`.

## Uninstalling

```bash
opencode-usage uninstall
```

Removes only the files this package installed (verified by ownership markers).
Your usage history is kept. `opencode-usage uninstall --purge` also deletes the
database (with confirmation). To also remove the npm package itself, run
`npm uninstall -g @skinnysheep/opencode-usage`.

## Limitations

- Tracking begins at install time; older history requires `opencode-usage import`.
- Cache token breakdowns depend on providers reporting cache usage.
- Cost data is an estimate of provider billing, computed from public pricing.
- The slash palette always shows exactly one entry: `/usage` (arbitrary filters like
  `/usage provider anthropic` are not in the popup — the typed `/usage ...` path can still work
  via the `usage` tool when the model cooperates, best-effort).
- Budgets are advisory only — nothing is enforced or blocked at the limit.

## Development

```bash
npm install
npm run build      # tsc (CLI + TUI, strict) + esbuild (self-contained plugin bundles)
npm test           # node --test (184 tests: normalization, pricing, storage, CLI, import/export, TUI)
```

Built for opencode 1.18.x, verified end-to-end against a live binary.
See `docs/opencode-integration-analysis.md` and `docs/architecture.md`.
