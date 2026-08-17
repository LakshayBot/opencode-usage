/**
 * Shared presentational atoms for the /usage popup.
 *
 * These follow the visual conventions of OpenCode's native dialogs
 * (DialogSelect): bold title + muted "esc" in the header row, muted secondary
 * text, `backgroundPanel` surfaces and theme tokens for everything. No
 * hardcoded colors — every color comes from `api.theme.current`.
 */

import type { TextProps } from "@opentui/solid"
import type { JSX } from "solid-js"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"

/** Native dialog header: bold title on the left, muted "esc" on the right. */
export function UsageHeader(props: { api: TuiPluginApi; title: string; hint?: string }): JSX.Element {
  const t = props.api.theme.current
  return (
    <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
      <text {...({ fg: t.text, bold: true } as TextProps)}>
        {props.title}
      </text>
      <text fg={t.textMuted}>{props.hint ?? "esc"}</text>
    </box>
  )
}

/** A label/​value row, label left, value right-aligned — like a select row. */
export function MetricRow(props: {
  t: TuiThemeCurrent
  label: string
  value: string
  mutedValue?: boolean
}): JSX.Element {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={2}>
      <text fg={props.t.text} wrapMode="none">
        {props.label}
      </text>
      <text fg={props.mutedValue ? props.t.textMuted : props.t.text} wrapMode="none">
        {props.value}
      </text>
    </box>
  )
}

/** Subtle horizontal rule used to group sections without borders. */
export function Divider(props: { t: TuiThemeCurrent; width: number }): JSX.Element {
  return (
    <text fg={props.t.borderSubtle} wrapMode="none">
      {"─".repeat(Math.max(8, props.width))}
    </text>
  )
}

/** Clean empty state — explains why there are zeros instead of showing them. */
export function UsageEmptyView(props: { api: TuiPluginApi; periodLabel: string }): JSX.Element {
  const t = props.api.theme.current
  return (
    <box gap={1} paddingBottom={1}>
      <UsageHeader api={props.api} title="Usage" />
      <box paddingLeft={4} paddingRight={4}>
        <text fg={t.textMuted}>{props.periodLabel}</text>
      </box>
      <box paddingLeft={4} paddingRight={4}>
        <text fg={t.text}>No usage has been recorded yet.</text>
        <text fg={t.textMuted}>Usage will appear here after you send messages through OpenCode.</text>
      </box>
    </box>
  )
}

/** Error state — never crashes, stays inside the native popup. */
export function UsageErrorView(props: { api: TuiPluginApi; error: string }): JSX.Element {
  const t = props.api.theme.current
  return (
    <box gap={1} paddingBottom={1}>
      <UsageHeader api={props.api} title="Usage" />
      <box paddingLeft={4} paddingRight={4}>
        <text fg={t.error}>Unable to load usage data.</text>
        <text fg={t.textMuted}>{props.error}</text>
      </box>
    </box>
  )
}
