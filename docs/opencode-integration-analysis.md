# OpenCode Integration Analysis

**Version analyzed:** opencode 1.18.18 (`dev` branch of `anomalyco/opencode`, commit cloned 2026-08-15 — version matches the locally installed binary exactly)

**Method:** source-code inspection of the cloned monorepo (`packages/opencode`, `packages/core`, `packages/plugin`, `packages/schema`, `packages/tui`, `packages/sdk`, `packages/llm`) plus official docs (opencode.ai/docs/plugins, /docs/commands) and live inspection of a real local install (`~/.config/opencode`, `~/.local/share/opencode/opencode.db`, binary at `~/.opencode/bin/opencode`).

---

## 1. OpenCode is a Bun-runtime application

- The `opencode` binary is a Bun-compiled application. All plugins (server + TUI) are `import()`ed and executed inside that Bun process.
- Implication: plugin code can use `node:sqlite` (`DatabaseSync`) with zero external dependencies — it is built into the Bun runtime.
- The local install shows a real, 1.6 GB `~/.local/share/opencode/opencode.db` with years of session history — historical import is both feasible and worthwhile.

## 2. Global paths (cross-platform)

OpenCode resolves paths with the `xdg-basedir` package, and exposes them via `packages/core/src/global.ts`:

| Purpose | Linux / macOS | Windows |
|---|---|---|
| Config (`Global.Path.config`) | `~/.config/opencode` | `%APPDATA%\opencode` |
| Data (`Global.Path.data`) | `~/.local/share/opencode` | `%LOCALAPPDATA%\opencode` |
| Cache | `~/.cache/opencode` | `%LOCALAPPDATA%\opencode` |

- `OPENCODE_CONFIG_DIR` env var overrides the config directory (`packages/core/src/flag/flag.ts`).
- `opencode.db` (SQLite) lives in the data dir.
- Local session data also exists under `Global.Path.data/storage` (JSON legacy storage, migrated into the DB).

**Conclusion:** our global install + tracking database should mirror this scheme exactly — a standards-compliant path derived from the same `xdg-basedir` rules, so all projects on the machine share one database.

## 3. Plugin architecture (the official extension mechanism)

`packages/plugin/src/index.ts` — the plugin contract in 1.18.18:

```ts
type Plugin = (input: PluginInput, options?) => Promise<Hooks>
```

`PluginInput` provides: `client` (full SDK client for the local server), `project`, `directory`, `worktree`, `serverUrl`, and `$` (Bun shell).

The `Hooks` surface relevant to usage tracking (all optional):

- `event({ event })` — **receives every event bus event** published by the server instance: `{ id, type, properties }` where `properties` is the schema-validated event payload. This is the primary integration point.
- `chat.message` — fires for every new user message: `{ sessionID, agent, model, messageID, variant }`.
- `command.execute.before` — fires before a slash command's template is sent to the LLM: `{ command, sessionID, arguments }`, can mutate `output.parts`.
- `tool: { name: tool({ description, args, execute }) }` — **registers a custom tool available to any agent** in any session. `execute(args, { sessionID, agent, directory, worktree, ... })`.
- `config(cfg)` — receives the merged config once at init (can mutate).
- `dispose()`.

TUI plugin API (`packages/plugin/src/tui.ts`, loaded from the same plugin dirs, exported as a second module export named `tui`):

- `api.command.register(() => TuiCommand[])` — legacy but wired (via `createCommandShim` in `packages/tui/src/plugin/command-shim.ts`) into the keymap command system. A `TuiCommand` supports `slash: { name, aliases }` + `onSelect()`. This is how `/usage` gets into the TUI's `/` command palette.
- `api.route.register({ name, render })` / `api.route.navigate(name, params)` — register and navigate to fully custom rendered routes (OpenTUI Solid JSX).
- `api.ui` — `Dialog`, `DialogAlert`, `DialogSelect`, `toast`, dialog stack.
- `api.state.session.messages(sessionID)`, `api.client` (SDK over the local server), `api.event` (event bus subscription), `api.theme`, `api.kv` (persistent key-value store for TUI state).

## 4. How plugins are loaded globally

`packages/opencode/src/config/plugin.ts` + `packages/opencode/src/plugin/index.ts`:

- **Auto-discovered plugin files:** any `{plugin,plugins}/*.{ts,js}` under `Global.Path.config` (i.e. `~/.config/opencode/plugin/` or `plugins/`) **or** the project's `.opencode/plugin(s)/`. No config entry required. (Docs confirmed: `~/.config/opencode/plugins/` is the global plugin directory.)
- **npm plugins:** entries in the `plugin` array of `opencode.json`, installed on demand by Bun at startup into `~/.cache/opencode/node_modules/`.
- Local plugins needing external packages require a `package.json` in the config directory (opencode runs `bun install` there at startup).
- Load order: global config plugins → project config plugins → global plugin dir → project plugin dir. Hooks run in sequence, deterministically.
- Plugin code is loaded via dynamic `import()` in the Bun runtime. A self-contained bundled plugin file therefore works with **zero resolution risk**.

**Conclusion for install:** the least invasive, officially supported, idempotent installation is writing our (bundled, self-contained) plugin file to `~/.config/opencode/plugin/opencode-usage.js`. It is auto-discovered, requires no edit of the user's `opencode.json`, cannot break their config, and is trivially removable. This is a documented, first-class mechanism (the same one the docs' examples use).

## 5. Slash commands

`packages/opencode/src/command/index.ts` + `packages/opencode/src/config/command.ts`:

- The server-side command registry is built from: built-ins (`/init`, `/review`), config `command` key, **MCP prompts**, and **skills**.
- **Global command files:** any `{command,commands}/**/*.md` under the config directories are auto-discovered (`~/.config/opencode/commands/usage.md` → `/usage`). Frontmatter (`description`, `agent`, `model`, `subtask`) + template body. Template supports `$ARGUMENTS`, `$1..$n`, `!`shell`` output injection, `@file` references.
- TUI submit flow (`packages/tui/src/component/prompt/index.tsx:1071`): if input starts with `/` and the name exists in the **server** command list (`sync.data.command`), the TUI calls `client.session.command({ command, arguments })`, which runs the template as a prompt. Otherwise the text is sent as a normal chat message.
- TUI palette flow (`packages/tui/src/keymap.tsx:260`, `autocomplete.tsx:553`): slash entries are collected from keymap commands carrying `slashName`; selecting one calls `keymap.dispatchCommand(name)` → the command's `run()` executes directly (no LLM call).
- The `command.execute.before` hook can intercept any command execution and mutate the parts that will be sent to the model.

**Conclusion for `/usage`:** register BOTH:
1. A **server-side command** (`~/.config/opencode/commands/usage.md`) so `/usage ...` typed + Enter works everywhere (template delegates to our custom `usage` tool, so the report is generated by code, not by the model).
2. A **TUI command** with `slashName: "usage"` from the TUI plugin, whose `onSelect` navigates to a native OpenTUI route rendering the report — zero tokens, native styling.

## 6. Usage metadata — the goldmine

OpenCode already captures exact, normalized usage and cost on every model step. `packages/schema/src/v1/session.ts`:

```ts
// StepFinishPart (per model request):
{ type: "step-finish", reason, cost, tokens: {
    total?, input, output, reasoning,
    cache: { read, write } } }

// AssistantMessage:
{ role: "assistant", agent, modelID, providerID, mode, path, cost, tokens: { ... } }

// SessionInfo (aggregated):
{ id, slug, projectID, directory, title, agent, model, cost?, tokens: { input, output, reasoning, cache: { read, write } }, time: { created, updated } }
```

**How it's produced** (`packages/opencode/src/session/llm/ai-sdk.ts` + `packages/opencode/src/session/processor.ts:435`):

1. AI SDK v6 `finish-step` event → `usage()` normalizes provider usage into `{ inputTokens, outputTokens, totalTokens, reasoningTokens, cacheReadInputTokens, cacheWriteInputTokens }` (inputTokenDetails.cacheReadTokens / cachedInputTokens etc.).
2. `Session.getUsage()` (`session/session.ts:338`) computes tokens + **cost using models.dev pricing**:

```
tokens.input   = inputTokens - cacheRead - cacheWrite   (AI SDK v6 inputTokens includes cache)
tokens.output  = outputTokens - reasoningTokens
cost = input·P_in/1M + output·P_out/1M + cacheRead·P_cacheRead/1M + cacheWrite·P_cacheWrite/1M + reasoning·P_out/1M
```

3. `session.updatePart(step-finish)` publishes **`message.part.updated`** with the full part; `session.updateMessage(assistant)` publishes **`message.updated`** with the full assistant message.

**This is the officially supported integration point:** the plugin's `event()` hook receives `message.part.updated` events containing the exact per-request tokens + cost. No token estimation is ever needed. The cost field is the authoritative estimated cost at the time of use (computed with then-current models.dev pricing).

Per-model attribution: `message.updated` assistant messages carry `modelID`/`providerID`/`agent`. Subagent traffic: subagents run in child sessions (`session.parentID`), and messages carry `agent` — so main-agent vs subagent vs other agents is distinguishable. Multiple `step-finish` parts within one assistant message = multiple model requests (tool-call loops).

Missing cache data: for providers that don't report cache tokens (e.g. OpenAI), `cache.read`/`cache.write` arrive as `0` from the AI SDK normalization only when the provider reported them; providers that never report them yield zeros which we treat as "not available" (we can distinguish by provider capability table + raw metadata rather than assuming).

## 7. OpenCode's own database

`packages/core/src/session/sql.ts` (drizzle schema on `opencode.db`):

- `session` table: `id, project_id, workspace_id, parent_id, slug, directory, path, title, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model (json), time_created, time_updated, ...` — **per-session aggregated usage and cost already persisted.**
- `message` table: `id, session_id, data (json)` — full message objects (assistant messages carry cost + tokens).
- `part` table: `id, message_id, session_id, data (json)` — full parts including every `step-finish`.

**Conclusion for historical import:** `opencode-usage import` can read `opencode.db` directly (read-only) and reconstruct per-request usage events from the `part` table (JSON `data`), join model/provider/agent from the `message` table, and session metadata from the `session` table. `part.id` is a globally unique, stable key → perfect dedup key. Sessions are already aggregated (cost + tokens) for session-level stats. We never write to `opencode.db`.

## 8. What opencode does NOT expose

- No plugin hook for "register a server command from a plugin" (commands come from config files/MCP/skills — hence the global command file).
- No direct "hook output to TUI rendering" for server hooks (hence the separate TUI plugin).
- No plugin hook for raw provider metadata per step (the `message.part.updated` part carries normalized tokens+cost, not the raw `providerMetadata`) — provider-specific quirks (e.g. Bedrock/Vertex cache key names) are already normalized by opencode itself.
- `event` delivery is scoped to the plugin's instance directory (`plugin/index.ts:254`): each project instance reports its own sessions — which is exactly what a global aggregator wants; each instance writes into the shared global database.

## 9. Key version pin

Everything above was verified against 1.18.18 (the `dev` branch version string equals the installed binary version). The plugin API is stable across recent releases (v1 plugin contract; `tui` plugin API introduced earlier in the 1.x line, currently behind `api.command` legacy shim which is still fully wired in 1.18.18).
