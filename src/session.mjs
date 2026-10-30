/**
 * transcript 解析：把多种会话记录格式压平成同一串事件。
 *
 * 支持三种输入形态（按行 JSON，JSONL）：
 *   A. Claude Code：{ type: "assistant"|"user", message: { role, content: Block[] } }
 *      其中 Block 可能是 text / tool_use / tool_result
 *   B. 简化形态：{ role: "assistant"|"user"|"tool", content: string, tool_call_id?, name? }
 *   C. function call 形态：{ type: "function_call"|"function_call_output", ... }
 *
 * 其他格式直接报错。模糊解析会制造假阴性；宁可拒绝，也不猜。
 */

export class TranscriptError extends Error {
  constructor(message, { line } = {}) {
    super(message)
    this.name = "TranscriptError"
    this.line = line
  }
}

/**
 * @typedef {{ kind: "assistant_text", turn: number, line: number, text: string }} AssistantTextEvent
 * @typedef {{ kind: "tool_use", turn: number, line: number, id: string, name: string, input: Record<string, unknown> }} ToolUseEvent
 * @typedef {{ kind: "tool_result", turn: number, line: number, id: string, tool: string, text: string, isError: boolean }} ToolResultEvent
 * @typedef {AssistantTextEvent | ToolUseEvent | ToolResultEvent} Event
 */

/**
 * @param {string} text transcript 全文
 * @param {{ file?: string }} [options]
 * @returns {{ file: string, turns: number, events: Event[], skippedLines: number }}
 */
export function parseTranscript(text, { file = "transcript" } = {}) {
  const events = []
  const idToName = new Map()
  let turn = 0
  let skippedLines = 0
  const lines = text.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim()
    if (raw === "") continue

    const lineNo = index + 1
    let record
    try {
      record = JSON.parse(raw)
    } catch {
      throw new TranscriptError(`第 ${lineNo} 行不是合法 JSON`, { line: lineNo })
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new TranscriptError(`第 ${lineNo} 行不是一个 JSON 对象`, { line: lineNo })
    }

    const before = events.length
    const role = detectRole(record)

    if (role === "assistant") {
      turn += 1
      const blocks = blocksOf(record.message?.content ?? record.content)
      pushAssistantBlocks(blocks, { turn, lineNo, events, idToName })
    } else if (role === "user") {
      const blocks = blocksOf(record.message?.content ?? record.content)
      pushToolResults(blocks, { turn, lineNo, events, idToName })
    } else if (role === "tool") {
      pushToolResults(
        [{ type: "tool_result", tool_use_id: record.tool_call_id, content: record.content, is_error: record.is_error }],
        { turn, lineNo, events, idToName, fallbackName: record.name },
      )
    } else if (role === "function_call") {
      if (turn === 0) turn = 1
      const id = String(record.id ?? record.call_id ?? `call-${lineNo}`)
      const name = String(record.name ?? "function_call")
      const input = parseArguments(record.arguments)
      idToName.set(id, name)
      events.push({ kind: "tool_use", turn, line: lineNo, id, name, input })
    } else if (role === "function_call_output") {
      const id = String(record.call_id ?? record.id ?? `call-${lineNo}`)
      pushToolResults(
        [{ type: "tool_result", tool_use_id: id, content: record.output, is_error: record.is_error }],
        { turn, lineNo, events, idToName },
      )
    } else {
      // system / summary / 未知记录：不参与分析，但计入跳过数
      skippedLines += 1
      continue
    }

    if (events.length === before) skippedLines += 1
  }

  if (events.length === 0) {
    throw new TranscriptError("没有解析出任何 tool_use / tool_result 事件，这个文件可能不是会话 transcript")
  }

  return { file, turns: turn, events, skippedLines }
}

function detectRole(record) {
  const type = typeof record.type === "string" ? record.type : undefined
  if (type === "assistant" || type === "user") return type
  if (type === "function_call" || type === "function_call_output") return type
  if (record.message && typeof record.message === "object") {
    const role = record.message.role
    if (role === "assistant" || role === "user") return role
  }
  const role = record.role
  if (role === "assistant" || role === "user" || role === "tool") return role
  if (type === "system" || type === "summary") return "ignore"
  return "ignore"
}

function blocksOf(content) {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (Array.isArray(content)) {
    return content.filter((block) => block !== null && typeof block === "object")
  }
  return []
}

function pushAssistantBlocks(blocks, { turn, lineNo, events, idToName }) {
  for (const block of blocks) {
    if (block.type === "tool_use") {
      const id = String(block.id ?? `call-${lineNo}-${events.length}`)
      const name = String(block.name ?? "unknown")
      idToName.set(id, name)
      events.push({
        kind: "tool_use",
        turn,
        line: lineNo,
        id,
        name,
        input: block.input !== null && typeof block.input === "object" ? block.input : {},
      })
    } else if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      events.push({ kind: "assistant_text", turn, line: lineNo, text: block.text })
    }
  }
}

function pushToolResults(blocks, { turn, lineNo, events, idToName, fallbackName }) {
  for (const block of blocks) {
    if (block.type !== "tool_result") continue
    const id = String(block.tool_use_id ?? block.id ?? "unknown")
    const tool = idToName.get(id) ?? fallbackName ?? block.name ?? "unknown"
    events.push({
      kind: "tool_result",
      turn,
      line: lineNo,
      id,
      tool: String(tool),
      text: textOf(block.content),
      isError: block.is_error === true,
    })
  }
}

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part !== null && typeof part === "object" && typeof part.text === "string") return part.text
        return ""
      })
      .filter((part) => part !== "")
      .join("\n")
  }
  return ""
}

function parseArguments(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === "object") return raw
  if (typeof raw !== "string") return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}
