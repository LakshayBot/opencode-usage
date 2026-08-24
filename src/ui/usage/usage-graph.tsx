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
 *
 * Native popup conventions (mirrors DialogSelect): the row area is a
 * scrollbox capped at half the terminal height, ↑/↓ scroll it, and the cost
 * column disappears entirely when no bucket has pricing data instead of
 * printing a column of "Unknown"s.
 */

import { For, Show, type JSX } from "solid-js"
import { useBindings } from "@opentui/keymap/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
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
  // Same cap the native DialogSelect uses for its option list.
  const maxHeight = Math.max(6, Math.floor(props.api.renderer.height / 2) - 6)

  const model = () => buildUsageTimelineModel(props.buckets, { metric: props.metric })
  const rows = () => model().rows
  const labelWidth = () => rows().reduce((max, row) => Math.max(max, row.label.length), 0)
  const toggleMetric = () => props.onToggleMetric(props.metric === "tokens" ? "cost" : "tokens")

  let scroll: ScrollBoxRenderable | undefined
  const scrollBy = (lines: number) => scroll?.scrollBy(lines)

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
      {
        name: "opencode-usage.scroll.up",
        title: "Scroll graph up",
        category: "Usage",
        run: () => scrollBy(-3),
      },
      {
        name: "opencode-usage.scroll.down",
        title: "Scroll graph down",
        category: "Usage",
        run: () => scrollBy(3),
      },
    ],
    bindings: [
      { key: "backspace", cmd: "opencode-usage.back" },
      { key: "left", cmd: "opencode-usage.metric" },
      { key: "right", cmd: "opencode-usage.metric" },
      { key: "up", cmd: "opencode-usage.scroll.up" },
      { key: "down", cmd: "opencode-usage.scroll.down" },
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
        <text fg={t.textMuted}>
          {props.periodLabel}
          <Show when={model().foldedToDaily}> · daily</Show>
        </text>
      </box>
      <box paddingLeft={4} paddingRight={4}>
        <scrollbox
          maxHeight={maxHeight}
          scrollbarOptions={{ visible: false }}
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
        >
          <For each={rows()}>
            {(row) => (
              <box flexDirection="row" gap={1}>
                <text fg={t.textMuted} wrapMode="none">
                  {row.label.padEnd(labelWidth())}
                </text>
                <text fg={t.primary} wrapMode="none">
                  {row.bar.padEnd(TIMELINE_BAR_WIDTH)}
                </text>
                <text fg={t.text} wrapMode="none">
                  {row.tokensText}
                </text>
                <Show when={model().costKnown}>
                  <text fg={row.cost === null ? t.textMuted : t.text} wrapMode="none">
                    {row.costText}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </scrollbox>
      </box>
      <box paddingLeft={4} paddingRight={4}>
        <Divider t={t} width={dividerWidth} />
      </box>
      <box paddingLeft={4} paddingRight={4}>
        <text fg={t.textMuted}>
          backspace back · ←→ tokens/cost · ↑↓ scroll · esc close
          <Show when={!model().costKnown}> · cost unknown (no pricing)</Show>
        </text>
      </box>
    </box>
  )
}
