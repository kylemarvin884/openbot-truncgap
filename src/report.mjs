/**
 * 终端报告。列宽固定、纯 ASCII，避免 Windows 控制台编码问题。
 */

const FOLLOW_UP_LABEL = {
  retry: (item) => `retried, narrower @turn ${item.turn}`,
  unverified: (item) => `conclusion @turn ${item.turn}, no retry`,
  silent: () => "silent",
}

/**
 * @param {ReturnType<import("./analyze.mjs").analyze>} result
 * @param {{ failOn?: string, failed?: boolean, version?: string }} [options]
 * @returns {string}
 */
export function formatScan(result, { failOn, failed = false, version = "0.1.0" } = {}) {
  const lines = []
  const rate = Math.round(result.rate * 100)

  lines.push(`truncgap ${version}   ${result.file}`)
  const summary = [
    `turns ${result.turns}`,
    `tool results ${result.toolResults}`,
    `truncated ${result.truncated} (${rate}%)`,
  ]
  const loss = formatLoss(result.lost)
  if (loss !== "") summary.push(loss)
  lines.push(summary.join("   "))
  lines.push("")

  if (result.findings.length === 0) {
    lines.push("no truncation evidence found in this transcript")
  } else {
    lines.push(...formatTable(result.findings))
    lines.push("")
    lines.push(
      `${result.truncated} truncated · ${result.followUp.recovered} recovered · ` +
        `${result.followUp.unverified} unverified conclusions · ${result.followUp.silent} silent`,
    )
    lines.push(
      `top tools: ${result.byTool.map((entry) => `${entry.tool} ${entry.truncated}`).join(", ")}`,
    )
  }

  for (const warning of result.warnings ?? []) lines.push(`warning: ${warning}`)

  lines.push(failOn ? (failed ? `exit 1 (--fail-on=${failOn})` : `exit 0 (--fail-on=${failOn})`) : "exit 0 (no --fail-on)")
  return lines.join("\n")
}

function formatTable(findings) {
  const header = ["line", "turn", "tool", "evidence", "follow-up"]
  const rows = findings.map((item) => [
    String(item.transcriptLine),
    String(item.turn),
    clip(item.tool, 20),
    clip(item.evidence, 46),
    FOLLOW_UP_LABEL[item.followUp.kind](item.followUp),
  ])

  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  )

  const render = (row) => row.map((cell, column) => pad(cell, widths[column])).join("  ").trimEnd()

  return [` ${render(header)}`, ...rows.map((row) => ` ${render(row)}`)]
}

function formatLoss(lost) {
  const parts = []
  if (lost.lines > 0) parts.push(`lost >= ${thousands(lost.lines)} lines`)
  if (lost.chars > 0) parts.push(`lost >= ${thousands(lost.chars)} chars`)
  if (lost.unknownCount > 0) parts.push(`${lost.unknownCount} unknown-size`)
  return parts.join("   ")
}

function thousands(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function pad(text, width) {
  return text + " ".repeat(Math.max(0, width - text.length))
}
