/**
 * The /usage overview — the first screen of the popup.
 *
 * Rendered inside the native dialog (dimmed backdrop, `backgroundPanel`,
 * centered, Esc handled by the host). Presents a compact hierarchy:
 *
 *   Summary    Messages / Tokens / Cost   (primary, immediately answerable)
 *   Breakdown  Input / Output / Cache R/W (secondary)
 *   Views      By model · By provider · History (navigable, native list)
 *
 * Navigation reuses OpenCode's dialog.select keybindings (up/ctrl+p,
 * down/ctrl+n, return) so it behaves exactly like the theme/model selectors.
 */

import { For, Show, type JSX } from "solid-js"
import { useBindings } from "@opentui/keymap/solid"
import type { TextProps } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ReportPeriod } from "../../types/usage.ts"
import { formatCost, formatNumber, formatPercent, formatTokens } from "./usage-format.ts"
import { Divider, MetricRow, UsageHeader } from "./usage-view.tsx"
import type { UsageOverviewModel } from "./usage-view-model.ts"

const PERIOD_LABELS: Partial<Record<ReportPeriod["kind"], string>> = {
  session: "Session",
  today: "Today",
  week: "Week",
  month: "Month",
  all: "All",
}

function samePeriod(a: ReportPeriod, b: ReportPeriod): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "session" && b.kind === "session") return a.sessionId === b.sessionId
  return true
}

export interface OverviewAction {
  title: string
  description?: string
  run: () => void
}

export function UsageOverviewView(props: {
  api: TuiPluginApi
  overview: UsageOverviewModel
  actions: OverviewAction[]
  /** Explicitly selected action. The navigation commands re-render the dialog
   * via `dialog.replace` with the next index instead of relying on reactive
   * prop updates — the host renderer does not reliably redraw plugin-rendered
   * row highlights inside the dialog (verified empirically on 1.18.18). */
  selectedIndex?: number
  /** Called with the next index when the user navigates. */
  onNavigate?: (nextIndex: number) => void
  /** Period tabs shown above the summary. */
  tabs?: ReportPeriod[]
  activePeriod?: ReportPeriod
  onSelectPeriod?: (period: ReportPeriod) => void
}): JSX.Element {
  const t = props.api.theme.current
  const count = () => props.actions.length
  const selected = props.selectedIndex ?? 0

  const dividerWidth = Math.max(8, Math.min(52, props.api.renderer.width - 12))

  // Register navigation with the host's own binding hook (`useBindings`),
  // active only while this dialog is open and cleaned up when it closes.
  //
  // We reuse the SAME command names and binding source as the host's native
  // DialogSelect ("dialog.select.prev/next/submit" bound via the user's
  // keybind config) instead of inventing our own command names + hardcoded
  // keys: opencode's default keymap already binds up/ctrl+p, down/ctrl+n and
  // return to those commands, and a plugin layer that binds "up"/"down" to
  // different command names loses the resolution race against them — the
  // symptom was arrow keys doing nothing in this overview. This way the
  // actions navigate exactly like the native By model / By provider lists
  // (and honor user rebinds).
  useBindings(() => {
    const move = (direction: number) => {
      const total = count()
      if (total === 0) return
      props.onNavigate?.((selected + direction + total) % total)
    }
    const moveTab = (direction: number) => {
      const tabs = props.tabs ?? []
      const fallback = tabs[0]
      if (!fallback) return
      const active = props.activePeriod ?? fallback
      const activeIndex = Math.max(0, tabs.findIndex((period) => samePeriod(period, active)))
      const next = tabs[(activeIndex + direction + tabs.length) % tabs.length]
      if (next) props.onSelectPeriod?.(next)
    }
    const commands = [
      {
        name: "dialog.select.prev",
        title: "Previous usage view",
        category: "Usage",
        run: () => move(-1),
      },
      {
        name: "dialog.select.next",
        title: "Next usage view",
        category: "Usage",
        run: () => move(1),
      },
      {
        name: "dialog.select.submit",
        title: "Open usage view",
        category: "Usage",
        run: () => props.actions[selected]?.run(),
      },
      {
        name: "opencode-usage.tab.prev",
        title: "Previous usage period",
        category: "Usage",
        run: () => moveTab(-1),
      },
      {
        name: "opencode-usage.tab.next",
        title: "Next usage period",
        category: "Usage",
        run: () => moveTab(1),
      },
    ]
    const gathered = props.api.tuiConfig.keybinds.gather("dialog.select", [
      "dialog.select.prev",
      "dialog.select.next",
      "dialog.select.submit",
    ])
    const bindings = [
      ...(gathered.length > 0
        ? gathered
        : [
            { key: "up", cmd: "dialog.select.prev" },
            { key: "ctrl+p", cmd: "dialog.select.prev" },
            { key: "down", cmd: "dialog.select.next" },
            { key: "ctrl+n", cmd: "dialog.select.next" },
            { key: "return", cmd: "dialog.select.submit" },
          ]),
      { key: "left", cmd: "opencode-usage.tab.prev" },
      { key: "right", cmd: "opencode-usage.tab.next" },
    ]
    return {
      enabled: () => props.api.ui.dialog.open,
      // Higher priority than the host's base/prompt layers so up/down/left/
      // right/return resolve to this dialog's commands while the popup is open
      // (the prompt layer still binds these keys in normal mode and would
      // otherwise win or hold the first press for disambiguation).
      priority: 50,
      commands,
      bindings,
    }
  })

  return (
    <box gap={1} paddingBottom={1}>
      <UsageHeader api={props.api} title="Usage" />

      <Show when={(props.tabs?.length ?? 0) > 1}>
        <box paddingLeft={4} paddingRight={4} flexDirection="row" alignItems="center" gap={1}>
          <For each={props.tabs}>
            {(period, index) => {
              const active = samePeriod(period, props.activePeriod ?? period)
              const label = PERIOD_LABELS[period.kind] ?? period.kind
              return (
                <>
                  {index() > 0 ? (
                    <text fg={t.textMuted} wrapMode="none">
                      ·
                    </text>
                  ) : null}
                  <box
                    backgroundColor={active ? t.primary : undefined}
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <text
                      {...({
                        fg: active ? t.selectedListItemText : t.textMuted,
                        bold: active,
                        wrapMode: "none",
                      } as TextProps)}
                    >
                      {label}
                    </text>
                  </box>
                </>
              )
            }}
          </For>
        </box>
      </Show>

      <box paddingLeft={4} paddingRight={4}>
        <text {...({ fg: t.text, bold: true, wrapMode: "none" } as TextProps)}>
          {props.overview.periodLabel}
        </text>
      </box>

      <box paddingLeft={4} paddingRight={4} gap={1}>
        <MetricRow t={t} label="Messages" value={formatNumber(props.overview.messages)} />
        <MetricRow t={t} label="Tokens" value={formatTokens(props.overview.totalTokens)} />
        <MetricRow
          t={t}
          label="Cost"
          value={props.overview.cost === null ? "Unknown" : formatCost(props.overview.cost)}
          mutedValue={props.overview.cost === null}
        />
      </box>

      <box paddingLeft={4} paddingRight={4}>
        <Divider t={t} width={dividerWidth} />
      </box>

      <box paddingLeft={4} paddingRight={4} gap={1}>
        <MetricRow t={t} label="Input" value={formatTokens(props.overview.inputTokens)} />
        <MetricRow t={t} label="Output" value={formatTokens(props.overview.outputTokens)} />
        <MetricRow t={t} label="Cache Read" value={formatTokens(props.overview.cacheReadTokens)} />
        <MetricRow t={t} label="Cache Write" value={formatTokens(props.overview.cacheWriteTokens)} />
        <Show when={props.overview.cacheAvailable}>
          <MetricRow t={t} label="Cache Hit" value={formatPercent(props.overview.cacheHitRate)} mutedValue />
        </Show>
      </box>

      <Show when={count() > 0}>
        <box paddingLeft={4} paddingRight={4}>
          <Divider t={t} width={dividerWidth} />
        </box>

        <For each={props.actions}>
          {(action, index) => {
            const active = () => selected === index()
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={4}
                paddingRight={4}
                backgroundColor={active() ? t.primary : undefined}
              >
                <text {...({ fg: active() ? t.selectedListItemText : t.text, bold: active(), wrapMode: "none" } as TextProps)}>
                  {action.title}
                </text>
                <Show when={action.description}>
                  <text fg={active() ? t.selectedListItemText : t.textMuted} wrapMode="none">
                    {action.description}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>

        <box paddingLeft={4} paddingRight={4}>
          <text fg={t.textMuted}>←→ period · ↑↓ navigate · enter open · esc close</text>
        </box>
      </Show>
    </box>
  )
}
