/**
 * opencode-usage TUI plugin (referenced from ~/.config/opencode/tui.json).
 *
 * Registers /usage today|week|month|all in the TUI command palette; selecting
 * one opens a native OpenCode dialog popup rendering the usage report — zero
 * LLM tokens consumed.
 *
 * Plain /usage is intentionally NOT registered here: it is already provided by
 * the installed global command file (commands/usage.md, the server-side LLM
 * path). opencode's slash autocomplete lists keymap slashName commands AND
 * every server command with no dedup, so registering slashName usage here too
 * made the palette show /usage twice (verified against 1.18.18 source,
 * packages/tui/src/component/prompt/autocomplete.tsx).
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
import { openUsage } from "../ui/usage/usage-overlay.tsx"

export default {
  id: "opencode-usage",
  tui: async (api: TuiPluginApi) => {
    api.keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: "usage.today",
          title: "OpenCode usage — today",
          desc: "Usage since midnight",
          category: "Usage",
          slashName: "usage today",
          run: () => openUsage(api, { kind: "today" }),
        },
        {
          namespace: "palette",
          name: "usage.week",
          title: "OpenCode usage — last 7 days",
          desc: "Usage over the last 7 days",
          category: "Usage",
          slashName: "usage week",
          run: () => openUsage(api, { kind: "week" }),
        },
        {
          namespace: "palette",
          name: "usage.month",
          title: "OpenCode usage — last 30 days",
          desc: "Usage over the last 30 days",
          category: "Usage",
          slashName: "usage month",
          run: () => openUsage(api, { kind: "month" }),
        },
        {
          namespace: "palette",
          name: "usage.all",
          title: "OpenCode usage — all time",
          desc: "Usage since tracking began",
          category: "Usage",
          slashName: "usage all",
          run: () => openUsage(api, { kind: "all" }),
        },
      ],
      bindings: [],
    })
  },
}
