/**
 * Detail views for the /usage popup.
 *
 * "By model", "By provider" and "History" are native `DialogSelect` lists —
 * the same component OpenCode uses for its theme and model selectors — so
 * search, arrow navigation, Enter and Esc close all come from the host.
 * The per-model detail is a compact summary rendered in the same popup.
 */

import type { JSX } from "solid-js"
import { useBindings } from "@opentui/keymap/solid"
import type { TextProps } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ReportPeriod } from "../../types/usage.ts"
import { formatCost, formatNumber, formatTokens } from "./usage-format.ts"
import { Divider, MetricRow, UsageHeader } from "./usage-view.tsx"
import type { UsageModelRowModel, UsagePeriodSummary, UsageProviderRowModel } from "./usage-view-model.ts"

export function UsageModelsDialog(props: {
  api: TuiPluginApi
  rows: UsageModelRowModel[]
  onSelectModel: (row: UsageModelRowModel) => void
}): JSX.Element {
  return (
    <props.api.ui.DialogSelect
      title="Usage by model"
      options={props.rows.map((row) => ({
        title: row.model,
        description: row.provider,
        footer: `${formatTokens(row.totalTokens)} · ${formatNumber(row.requests)} req · ${formatCost(row.cost)}`,
        value: row,
        onSelect: () => props.onSelectModel(row),
      }))}
      flat
    />
  )
}

export function UsageProvidersDialog(props: {
  api: TuiPluginApi
  rows: UsageProviderRowModel[]
}): JSX.Element {
  return (
    <props.api.ui.DialogSelect
      title="Usage by provider"
      options={props.rows.map((row) => ({
        title: row.provider,
        footer: `${formatNumber(row.requests)} req · ${formatTokens(row.totalTokens)} · ${formatCost(row.cost)}`,
        value: row,
      }))}
      flat
    />
  )
}

export function UsageHistoryDialog(props: {
  api: TuiPluginApi
  summaries: UsagePeriodSummary[]
  activePeriod: ReportPeriod
  onSelectPeriod: (period: ReportPeriod) => void
}): JSX.Element {
  return (
    <props.api.ui.DialogSelect
      title="Usage — period"
      options={props.summaries.map((summary) => ({
        title: summary.label,
        description: `${formatNumber(summary.requests)} req · ${formatTokens(summary.totalTokens)} tokens`,
        footer: summary.cost === null ? "cost unknown" : formatCost(summary.cost),
        value: summary.period,
        onSelect: () => props.onSelectPeriod(summary.period),
      }))}
      current={props.activePeriod}
      flat
    />
  )
}

export function UsageModelDetailView(props: {
  api: TuiPluginApi
  model: UsageModelRowModel
  onBack: () => void
}): JSX.Element {
  const t = props.api.theme.current
  const dividerWidth = Math.max(8, Math.min(52, props.api.renderer.width - 12))

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

  return (
    <box gap={1} paddingBottom={1}>
      <UsageHeader api={props.api} title="Model" />
      <box paddingLeft={4} paddingRight={4}>
        <text {...({ fg: t.text, bold: true, wrapMode: "none" } as TextProps)}>
          {props.model.model}
        </text>
        <text fg={t.textMuted} wrapMode="none">
          {props.model.provider}
        </text>
      </box>
      <box paddingLeft={4} paddingRight={4} gap={1}>
        <MetricRow t={t} label="Requests" value={formatNumber(props.model.requests)} />
        <MetricRow t={t} label="Tokens" value={formatTokens(props.model.totalTokens)} />
        <MetricRow t={t} label="Input" value={formatTokens(props.model.inputTokens)} />
        <MetricRow t={t} label="Output" value={formatTokens(props.model.outputTokens)} />
        <MetricRow
          t={t}
          label="Cost"
          value={formatCost(props.model.cost)}
          mutedValue={props.model.cost === null}
        />
      </box>
      <box paddingLeft={4} paddingRight={4}>
        <Divider t={t} width={dividerWidth} />
      </box>
      <box paddingLeft={4} paddingRight={4}>
        <text fg={t.textMuted}>backspace back · esc close</text>
      </box>
    </box>
  )
}
