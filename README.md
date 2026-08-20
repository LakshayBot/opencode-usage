# OpenCode Usage

[![npm](https://img.shields.io/npm/v/@skinnysheep/opencode-usage)](https://www.npmjs.com/package/@skinnysheep/opencode-usage)
[![GitHub](https://img.shields.io/badge/source-github-181717?logo=github)](https://github.com/LakshayBot/opencode-usage)
[![GitHub stars](https://img.shields.io/github/stars/LakshayBot/opencode-usage?style=social)](https://github.com/LakshayBot/opencode-usage)

**⭐ Like this plugin? Star the repo — it helps others discover it.**

Track your **OpenCode** token usage, cache statistics and estimated costs — across **all** your projects, from one global database.

```
/usage
```

```
MESSAGES
User Messages:          128
Assistant Messages:     127
Model Requests:         312
Sessions:               42

TOKENS
Input:              1,245,000
Output:               342,000
Cache Read:         4,830,000
Cache Write:          215,000
Total Processed:    6,632,000

CACHE
Cache Hit Rate:         79.5%
Estimated Savings:     $18.92

COST (ESTIMATED)
Input Cost:             $4.21
Output Cost:            $5.13
...
Estimated Total:       $14.27
```

## Installation

Requires **Node.js >= 23.4** for the CLI (the plugin itself runs inside opencode's bundled Bun runtime — nothing extra to install).

```bash
npm install -g @skinnysheep/opencode-usage
opencode-usage install
```

Restart opencode (or start a new session). Select `/usage` in the palette — the native report popup opens in any project.

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

## Usage

The slash palette shows **exactly one entry**: `/usage`. Selecting it opens a
**native OpenCode-style popup** (zero LLM tokens, theme-aware, Esc to close) —
the same dialog system behind the theme and model selectors — so the report
looks and behaves identically no matter which model is active.

Inside the popup, **period tabs** switch between scopes:

```
Session · Today · Week · Month · All
```

- Opened from inside a session → `Session` is the default (that session);
  otherwise `Today`. `←` `→` (or the tabs' label) switches period.
- `↑` `↓` navigate the actions (`By model · By provider · History`);
  `Enter` opens the highlighted one; `Esc`/`Ctrl+C` closes.

The same popup powers every scope, so the whole history (sessions, today, last
7 days, last 30 days, all time) is reachable without a single model call.
Typing `/usage ...` + Enter instead sends the text to the model — the `usage`
tool is still registered by the server plugin, so a capable model can still
produce a report on request (one small model call, best-effort; use the palette
for the byte-exact popup).

## CLI

```
opencode-usage install              Install the global integration
opencode-usage uninstall            Remove it (usage history kept)
opencode-usage uninstall --purge    ...and delete the database (confirms)
opencode-usage status               Installation + tracking status
opencode-usage stats [period]       Print a report (session|today|week|month|all)
opencode-usage stats --json         Machine-readable report
opencode-usage import               Import history from opencode's own database
opencode-usage update-pricing       Sync model pricing from models.dev
opencode-usage reset [--yes]        Wipe usage history (interactive confirm)
```

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
database (with confirmation).

## Limitations

- Tracking begins at install time; older history requires `opencode-usage import`.
- Cache token breakdowns depend on providers reporting cache usage.
- Cost data is an estimate of provider billing, computed from public pricing.
- The slash palette always shows exactly one entry: `/usage` (arbitrary filters like
  `/usage provider anthropic` are not in the popup — the typed `/usage ...` path can still work
  via the `usage` tool when the model cooperates, best-effort).

## Development

```bash
npm install
npm run build      # tsc + esbuild (CLI + self-contained plugin bundles)
npm test           # node --test (80 tests: normalization, pricing, storage, CLI, import, TUI formatting)
```

Built for opencode 1.18.18, verified end-to-end against a live binary.
See `docs/opencode-integration-analysis.md` and `docs/architecture.md`.
