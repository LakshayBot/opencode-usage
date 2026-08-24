/**
 * "By project" view for the /usage popup.
 *
 * A native `DialogSelect` list cloned from the By model / By provider views,
 * so search, arrow navigation and Enter/Esc all come from the host. There is
 * no project detail drill-down (rows carry no onSelect). Like the graph
 * subview it registers backspace as "back to the overview" on a keymap layer
 * that strictly outranks the overview's own layer (dialog.replace swaps
 * content but leaves the previous view's bindings registered; equal priority
 * resolves to registration order — older wins).
 */

import type { JSX } from "solid-js"
import { useBindings } from "@opentui/keymap/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { formatCost, formatNumber, formatTokens } from "./usage-format.ts"
import type { UsageProjectRowModel } from "./usage-view-model.ts"

export function UsageProjectsDialog(props: {
  api: TuiPluginApi
  rows: UsageProjectRowModel[]
  onBack: () => void
}): JSX.Element {
  useBindings(() => ({
    enabled: () => props.api.ui.dialog.open,
    commands: [
      {
        name: "opencode-usage.back",
        title: "Back to usage views",
        category: "Usage",
        run: () => props.onBack(),
      },
    ],
    bindings: [{ key: "backspace", cmd: "opencode-usage.back" }],
    // Must STRICTLY outrank the overview layer (50): see usage-graph.tsx.
    priority: 60,
  }))

  return (
    <props.api.ui.DialogSelect
      title="Usage by project"
      options={props.rows.map((row) => ({
        title: row.project,
        footer: `${formatTokens(row.totalTokens)} · ${formatNumber(row.requests)} req · ${formatCost(row.cost)}`,
        value: row,
      }))}
      flat
    />
  )
}
