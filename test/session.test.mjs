import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { parseTranscript, TranscriptError } from "../src/session.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const lossy = readFileSync(join(here, "..", "demo", "session-lossy.jsonl"), "utf8")

test("解析 Claude Code 形态：turn 数、tool_result 与工具名对应", () => {
  const parsed = parseTranscript(lossy, { file: "lossy.jsonl" })

  assert.equal(parsed.turns, 9)
  assert.equal(parsed.file, "lossy.jsonl")

  const results = parsed.events.filter((event) => event.kind === "tool_result")
  assert.equal(results.length, 6)
  assert.equal(results[0].tool, "Bash")
  assert.equal(results[0].line, 2)
  assert.equal(results[2].isError, true)
  assert.equal(results[3].tool, "Read")
  assert.equal(results[4].tool, "Read")
  assert.equal(results[5].tool, "mcp__repo__search_code")
})

test("tool_use 保留 input，assistant_text 只收非空文本", () => {
  const parsed = parseTranscript(lossy)
  const uses = parsed.events.filter((event) => event.kind === "tool_use")
  assert.equal(uses.length, 6)
  assert.equal(uses[0].input.command, 'grep -rn "withRetry" src/')
  assert.deepEqual(uses[2].input, { command: "npm test" })

  const texts = parsed.events.filter((event) => event.kind === "assistant_text")
  assert.ok(texts.length >= 5)
  for (const text of texts) assert.notEqual(text.text.trim(), "")
})

test("简化形态 { role, content } 也能读", () => {
  const text = [
    JSON.stringify({ role: "assistant", content: "checking the log" }),
    JSON.stringify({ role: "tool", tool_call_id: "c1", name: "Bash", content: "line 1\n[truncated] line 2" }),
  ].join("\n")

  const parsed = parseTranscript(text)
  assert.equal(parsed.turns, 1)
  const result = parsed.events.find((event) => event.kind === "tool_result")
  assert.equal(result.tool, "Bash")
  assert.match(result.text, /\[truncated\]/)
})

test("function_call / function_call_output 形态也能读", () => {
  const text = [
    JSON.stringify({ type: "function_call", call_id: "c9", name: "shell", arguments: '{"cmd":"ls"}' }),
    JSON.stringify({ type: "function_call_output", call_id: "c9", output: "a.ts\nb.ts" }),
  ].join("\n")

  const parsed = parseTranscript(text)
  const use = parsed.events.find((event) => event.kind === "tool_use")
  const result = parsed.events.find((event) => event.kind === "tool_result")
  assert.equal(use.input.cmd, "ls")
  assert.equal(result.tool, "shell")
  assert.equal(result.text, "a.ts\nb.ts")
})

test("坏 JSON 行报错，并带行号", () => {
  assert.throws(
    () => parseTranscript('{"role":"assistant","content":"ok"}\n{not json'),
    (error) => error instanceof TranscriptError && error.line === 2,
  )
})

test("没有任何 tool 事件的文件直接拒绝", () => {
  assert.throws(
    () => parseTranscript('{"type":"summary","summary":"nothing here"}'),
    /没有解析出任何 tool_use/,
  )
})
