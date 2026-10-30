/**
 * 关联分析：截断之后，agent 是换了更窄的命令重试，还是直接下结论。
 *
 * 这里的判断都是启发式，输出里必须保留原文出处（transcript 行号 + turn），
 * 让人能自己去看一眼。
 */
import { detectTruncation } from "./detect.mjs"

const NARROW_KEY_RE =
  /"(?:limit|offset|head_limit|max_results|max_count|top_k|page|start|end|first|count|max_chars|max_lines|num_results)":/i

const NARROW_CMD_RE =
  /(?:^|\s)(?:--include\b|--exclude\b|-m\s*\d|--max-count\b|-A\s*\d|-B\s*\d|-C\s*\d|\|\s*(?:head|tail|grep|wc)\b|head\s+-n|tail\s+-n)/i

/** 结论式措辞。只用来标记「这里有一句断言」，不判断对错。 */
const CONCLUSION_RE =
  /\bno other\b|\bnothing else\b|\bno more\b|\bonly one\b|\ball (?:tests? )?(?:pass|passes|passing)\b|\benvironment\b|\bflak(?:e|y)\b|\bsafe to\b|没有其他|没有别的|不存在|只有一|环境问题|偶发|可以放心|没问题/i

/**
 * @param {{ file: string, turns: number, events: import("./session.mjs").Event[] }} parsed
 * @param {{ maxFollow?: number }} [options]
 */
export function analyze(parsed, { maxFollow = 6 } = {}) {
  const { events } = parsed
  const calls = []
  const resultById = new Map()

  events.forEach((event, index) => {
    if (event.kind === "tool_use") calls.push({ event, index })
    if (event.kind === "tool_result" && !resultById.has(event.id)) resultById.set(event.id, event)
  })

  const findings = []
  events.forEach((event, index) => {
    if (event.kind !== "tool_result") return
    const detection = detectTruncation(event.text)
    if (!detection) return

    const followUp = classifyFollowUp({ events, index, event, detection, calls, resultById, maxFollow })
    findings.push({
      transcriptLine: event.line,
      turn: event.turn,
      tool: event.tool,
      kind: detection.kind,
      evidence: detection.evidence,
      lostLines: detection.lostLines ?? 0,
      lostChars: detection.lostChars ?? 0,
      payloadChars: event.text.length,
      isError: event.isError,
      followUp,
    })
  })

  const toolResults = events.filter((event) => event.kind === "tool_result").length
  const lostLines = findings.reduce((sum, item) => sum + item.lostLines, 0)
  const lostChars = findings.reduce((sum, item) => sum + item.lostChars, 0)
  const unknownCount = findings.filter((item) => item.lostLines === 0 && item.kind === "marked").length

  const countKind = (kind) => findings.filter((item) => item.followUp.kind === kind).length

  const warnings = []
  if (toolResults === 0) {
    warnings.push(
      "no tool_result records found; this file may use a transcript format truncgap does not understand",
    )
  }

  return {
    schema: "truncgap/1",
    file: parsed.file,
    turns: parsed.turns,
    toolResults,
    truncated: findings.length,
    rate: toolResults === 0 ? 0 : findings.length / toolResults,
    warnings,
    lost: { lines: lostLines, chars: lostChars, unknownCount },
    followUp: {
      recovered: countKind("retry"),
      unverified: countKind("unverified"),
      silent: countKind("silent"),
    },
    byTool: groupByTool(findings),
    findings,
  }
}

function classifyFollowUp({ events, index, event, detection, calls, resultById, maxFollow }) {
  const windowEnd = event.turn + maxFollow

  for (const call of calls) {
    if (call.index <= index) continue
    if (call.event.turn > windowEnd) break
    if (call.event.name !== event.tool) continue
    if (!isNarrower(call.event, event, resultById)) continue
    return { kind: "retry", turn: call.event.turn, tool: call.event.name }
  }

  const nextCallIndex = calls.find((call) => call.index > index)?.index ?? Number.POSITIVE_INFINITY
  for (let cursor = index + 1; cursor < events.length && cursor < nextCallIndex; cursor += 1) {
    const candidate = events[cursor]
    if (candidate.kind !== "assistant_text") continue
    if (!CONCLUSION_RE.test(candidate.text)) continue
    return { kind: "unverified", turn: candidate.turn, quote: firstLine(candidate.text) }
  }

  return { kind: "silent" }
}

function isNarrower(call, resultEvent, resultById) {
  const input = call.input ?? {}
  if (NARROW_KEY_RE.test(JSON.stringify(input))) return true

  const command = typeof input.command === "string" ? input.command : ""
  if (command !== "" && NARROW_CMD_RE.test(command)) return true

  const newLength = resultById.get(call.id)?.text?.length ?? 0
  const oldLength = resultEvent.text.length
  if (newLength > 0 && oldLength > 0 && newLength < oldLength * 0.6) return true

  return false
}

function groupByTool(findings) {
  const map = new Map()
  for (const item of findings) {
    const entry = map.get(item.tool) ?? { tool: item.tool, truncated: 0, lostLines: 0 }
    entry.truncated += 1
    entry.lostLines += item.lostLines
    map.set(item.tool, entry)
  }
  return [...map.values()].sort(
    (a, b) => b.truncated - a.truncated || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0),
  )
}

function firstLine(text) {
  const line = text.split(/\r?\n/).find((part) => part.trim() !== "") ?? ""
  const trimmed = line.trim()
  return trimmed.length > 96 ? `${trimmed.slice(0, 93)}...` : trimmed
}
