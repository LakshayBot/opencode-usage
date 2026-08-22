/**
 * "Graph" subview for the /usage popup — activity over time.
 *
 * One line per time bucket: `<label> <bar> <tokens> <cost>`. Bars are Unicode
 * block characters scaled to the busiest bucket (see buildUsageTimelineModel),
 * so the column reads like a usage graph; label/bar columns are padded so the
 * token and cost columns line up across rows. Pressing 't' toggles the bars
 * between token volume and dollar cost — the metric is component-local state,
 * so it resets whenever a fresh dialog render replaces this view. Like the
 * model detail view it renders inside the native dialog (Esc close comes from
 * the host) and binds backspace/left to go back to the overview.
 */

import { For, createSignal, type JSX } from "solid-js"
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
  /** Raw buckets — rows derive reactively so 't' can rescale them in place. */
  buckets: TimelineBucket[]
  onBack: () => void
}): JSX.Element {
  const t = props.api.theme.current
  const dividerWidth = Math.max(8, Math.min(52, props.api.renderer.width - 12))
  const labelWidth = props.buckets.reduce((max, bucket) => Math.max(max, bucket.label.length), 0)

  // Metric mode starts on tokens for every freshly mounted view; unmounting
  // the component (dialog close / navigation) discards it automatically.
  const [metric, setMetric] = createSignal<UsageTimelineMetric>("tokens")
  const rows = () => buildUsageTimelineModel(props.buckets, { metric: metric() })
  const toggleMetric = () => setMetric((current) => (current === "tokens" ? "cost" : "tokens"))

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
    bindings: [
      { key: "backspace", cmd: "opencode-usage.back" },
      { key: "left", cmd: "opencode-usage.back" },
    ],
  }))

  // Same pattern as the back binding above: active only while this dialog is
  // open and cleaned up when it closes.
  useBindings(() => ({
    enabled: () => props.api.ui.dialog.open,
    commands: [
      {
        name: "opencode-usage.metric",
        title: "Toggle tokens/cost metric",
        category: "Usage",
        run: toggleMetric,
      },
    ],
    bindings: [{ key: "t", cmd: "opencode-usage.metric" }],
  }))

  return (
    <box gap={1} paddingBottom={1}>
      <UsageHeader api={props.api} title={metric() === "cost" ? "COST OVER TIME" : "TOKENS OVER TIME"} />
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
        <text fg={t.textMuted}>backspace back · t metric · esc close</text>
      </box>
    </box>
  )
}
