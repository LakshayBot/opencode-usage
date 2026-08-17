/**
 * opencode-usage TUI plugin (referenced from ~/.config/opencode/tui.json).
 *
 * Registers EXACTLY ONE palette command — /usage — which opens the native
 * OpenCode dialog popup (zero LLM tokens, identical for every model). All
 * period switching happens INSIDE the popup via tabs (Session/Today/Week/
 * Month/All), so the slash palette stays clean: no /usage today|week|month|all
 * entries.
 *
 * /usage lives HERE (keymap popup) and NOT in a commands/usage.md file:
 * opencode's slash autocomplete lists keymap slashName commands AND every
 * server command with no dedup (packages/tui/src/component/prompt/autocomplete.tsx
 * in 1.18.18), so a command file plus this keymap entry produced two /usage
 * palette entries. The popup also keeps the report out of the chat — a command
 * file forces a model call that renders the report as a chat message.
 *
 * The popup reuses the host's dialog system (`api.ui.dialog` + `api.ui.Dialog`
 * / `api.ui.DialogSelect`), so it gets the same backdrop, theming, widths,
 * Esc/ctrl+c close handling and keyboard navigation as the built-in theme and
 * model selectors.
 *
 * Bundled self-contained. JSX runtime imports (solid-js, @opentui/solid) are
 * kept external: the opencode TUI host rewrites them to its own runtime
 * modules (opentui runtime-plugin-support).
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ReportPeriod } from "../types/usage.ts"
import { openUsage } from "../ui/usage/usage-overlay.tsx"

export default {
  id: "opencode-usage",
  tui: async (api: TuiPluginApi) => {
    /** The currently open session when one exists, otherwise "today". */
    function periodForCurrentRoute(): ReportPeriod {
      const current = api.route.current
      if (current?.name === "session" && typeof current.params?.sessionID === "string") {
        return { kind: "session", sessionId: current.params.sessionID }
      }
      return { kind: "today" }
    }

    api.keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: "usage",
          title: "OpenCode usage",
          desc: "Usage report — current session (tabs switch period)",
          category: "Usage",
          slashName: "usage",
          run: () => openUsage(api, periodForCurrentRoute()),
        },
      ],
      bindings: [],
    })
  },
}
