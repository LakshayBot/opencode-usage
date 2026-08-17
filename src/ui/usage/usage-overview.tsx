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
import { box, text } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { formatCost, formatNumber, formatPercent, formatTokens } from "./usage-format.ts"
import { Divider, MetricRow, UsageHeader } from "./usage-view.tsx"
import type { UsageOverviewModel } from "./usage-view-model.ts"

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
    ]
    const gathered = props.api.tuiConfig.keybinds.gather("dialog.select", [
      "dialog.select.prev",
      "dialog.select.next",
      "dialog.select.submit",
    ])
    const bindings =
      gathered.length > 0
        ? gathered
        : [
            { key: "up", cmd: "dialog.select.prev" },
            { key: "ctrl+p", cmd: "dialog.select.prev" },
            { key: "down", cmd: "dialog.select.next" },
            { key: "ctrl+n", cmd: "dialog.select.next" },
            { key: "return", cmd: "dialog.select.submit" },
          ]
    return {
      enabled: () => props.api.ui.dialog.open,
      // Higher priority than the host's base/prompt layers so up/down/return
      // resolve to this dialog's commands while the popup is open (the prompt
      // layer still binds these keys in normal mode and would otherwise win or
      // hold the first press for disambiguation).
      priority: 50,
      commands,
      bindings,
    }
  })

  return (
    <box gap={1} paddingBottom={1}>
      <UsageHeader api={props.api} title="Usage" />

      <box paddingLeft={4} paddingRight={4}>
        <text fg={t.textMuted}>{props.overview.periodLabel}</text>
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
            const active = () => selected() === index()
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={4}
                paddingRight={4}
                backgroundColor={active() ? t.primary : undefined}
              >
                <text fg={active() ? t.selectedListItemText : t.text} bold={active()} wrapMode="none">
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
          <text fg={t.textMuted}>↑↓ navigate · enter open · esc close</text>
        </box>
      </Show>
    </box>
  )
}
