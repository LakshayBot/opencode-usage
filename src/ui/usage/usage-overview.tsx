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

import { For, Show, createSignal, type JSX } from "solid-js"
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
}): JSX.Element {
  const t = props.api.theme.current
  const count = () => props.actions.length
  const [selected, setSelected] = createSignal(0)

  const dividerWidth = Math.max(8, Math.min(52, props.api.renderer.width - 12))

  // Register navigation with the host's own binding hook (`useBindings`),
  // active only while this dialog is open and cleaned up when it closes.
  useBindings(() => ({
    enabled: () => props.api.ui.dialog.open,
    commands: [
      {
        name: "opencode-usage.nav.prev",
        title: "Previous usage view",
        category: "Usage",
        run: () => setSelected((s) => (count() === 0 ? 0 : (s + count() - 1) % count())),
      },
      {
        name: "opencode-usage.nav.next",
        title: "Next usage view",
        category: "Usage",
        run: () => setSelected((s) => (count() === 0 ? 0 : (s + 1) % count())),
      },
      {
        name: "opencode-usage.nav.select",
        title: "Open usage view",
        category: "Usage",
        run: () => props.actions[selected()]?.run(),
      },
    ],
    bindings: [
      { key: "up", cmd: "opencode-usage.nav.prev" },
      { key: "ctrl+p", cmd: "opencode-usage.nav.prev" },
      { key: "down", cmd: "opencode-usage.nav.next" },
      { key: "ctrl+n", cmd: "opencode-usage.nav.next" },
      { key: "return", cmd: "opencode-usage.nav.select" },
    ],
  }))

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
