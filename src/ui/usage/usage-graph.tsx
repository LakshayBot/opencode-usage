/**
 * "Graph" subview for the /usage popup — activity over time.
 *
 * One line per time bucket: `<label> <bar> <tokens> <cost>`. Bars are Unicode
 * block characters scaled to the busiest bucket (see buildUsageTimelineModel),
 * so the column reads like a usage graph; label/bar columns are padded so the
 * token and cost columns line up across rows. LEFT/RIGHT toggles the metric
 * between token volume and dollar cost. The metric is CONTROLLED state owned
 * by the overlay (showGraph), not component-local signal state: the host
 * renderer does not reliably repaint plugin-rendered dialog content on
 * reactive updates (same empirically-verified limitation as overview row
 * highlights), so toggling re-issues dialog.replace with the flipped metric —
 * the exact workaround showOverview uses for navigation. Like the model
 * detail view it renders inside the native dialog (Esc close comes from the
 * host); backspace goes back to the overview.
 */

import { For, type JSX } from "solid-js"
import { useBindings } from "@opentui/keymap/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { TimelineBucket } from "../../reporting/usage-report.ts"
import { Divider, UsageHeader } from "./usage-view.tsx"
import {
  TIMELINE_BAR_WIDTH,
  buildUsageTimelineModel,
  type UsageTimelineMetric,
} from "./usage-view-model.ts"

export function UsageGraphView(props: {
  api: TuiPluginApi
  periodLabel: string
  buckets: TimelineBucket[]
  /** Current metric, controlled by the overlay via showGraph(..., metric). */
  metric: UsageTimelineMetric
  onBack: () => void
  /** Called with the flipped metric; the overlay re-renders the dialog. */
  onToggleMetric: (next: UsageTimelineMetric) => void
}): JSX.Element {
  const t = props.api.theme.current
  const dividerWidth = Math.max(8, Math.min(52, props.api.renderer.width - 12))
  const labelWidth = props.buckets.reduce((max, bucket) => Math.max(max, bucket.label.length), 0)

  const rows = () => buildUsageTimelineModel(props.buckets, { metric: props.metric })
  const toggleMetric = () => props.onToggleMetric(props.metric === "tokens" ? "cost" : "tokens")

  // One combined registration (the overview's proven pattern): active only
  // while this dialog is open, cleaned up when it closes.
  //
  // Metric toggling deliberately uses LEFT/RIGHT — special keys resolve
  // through plugin layers reliably (same as dialog.select prev/next), while
  // plain character keys are consumed by the host's prompt layer before
  // plugin keymaps see them (verified empirically on 1.18.21: a bound 't'
  // never fires regardless of layer priority).
  useBindings(() => ({
    enabled: () => props.api.ui.dialog.open,
    commands: [
      {
        name: "opencode-usage.back",
        title: "Back to usage views",
        category: "Usage",
        run: () => props.onBack(),
      },
      {
        name: "opencode-usage.metric",
        title: "Toggle tokens/cost metric",
        category: "Usage",
        run: toggleMetric,
      },
    ],
    bindings: [
      { key: "backspace", cmd: "opencode-usage.back" },
      { key: "left", cmd: "opencode-usage.metric" },
      { key: "right", cmd: "opencode-usage.metric" },
    ],
    // Must STRICTLY outrank the overview layer (50): dialog.replace swaps
    // content but leaves the previous view's keymap layer registered, so the
    // stale overview still claims left/right as period-tab prev/next. Equal
    // priority resolves to registration order (older wins) — verified
    // empirically on 1.18.21 (LEFT inside graph flipped the hidden overview's
    // tab instead of the metric). 60 puts the active subview in charge.
    priority: 60,
  }))

  return (
    <box gap={1} paddingBottom={1}>
      <UsageHeader api={props.api} title={props.metric === "cost" ? "COST OVER TIME" : "TOKENS OVER TIME"} />
      <box paddingLeft={4} paddingRight={4}>
        <text fg={t.textMuted}>{props.periodLabel}</text>
      </box>
      <box paddingLeft={4} paddingRight={4}>
        <For each={rows()}>
          {(row) => (
            <box flexDirection="row" gap={1}>
              <text fg={t.textMuted} wrapMode="none">
                {row.label.padEnd(labelWidth)}
              </text>
              <text fg={t.primary} wrapMode="none">
                {row.bar.padEnd(TIMELINE_BAR_WIDTH)}
              </text>
              <text fg={t.text} wrapMode="none">
                {row.tokensText}
              </text>
              <text fg={row.cost === null ? t.textMuted : t.text} wrapMode="none">
                {row.costText}
              </text>
            </box>
          )}
        </For>
      </box>
      <box paddingLeft={4} paddingRight={4}>
        <Divider t={t} width={dividerWidth} />
      </box>
      <box paddingLeft={4} paddingRight={4}>
        <text fg={t.textMuted}>backspace back · ←→ tokens/cost · esc close</text>
      </box>
    </box>
  )
}
