import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { analyze } from "../src/analyze.mjs"
import { parseTranscript } from "../src/session.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(join(here, "..", "demo", name), "utf8")

test("fixture 统计：4 处截断，2 次重试，2 处直接下结论", () => {
  const result = analyze(parseTranscript(read("session-lossy.jsonl"), { file: "lossy" }))

  assert.equal(result.schema, "truncgap/1")
  assert.equal(result.turns, 9)
  assert.equal(result.toolResults, 6)
  assert.equal(result.truncated, 4)
  assert.equal(result.followUp.recovered, 2)
  assert.equal(result.followUp.unverified, 2)
  assert.equal(result.followUp.silent, 0)
  assert.equal(result.lost.lines, 3354)
  assert.equal(result.lost.unknownCount, 1)
  assert.deepEqual(
    result.byTool.map((entry) => [entry.tool, entry.truncated]),
    [
      ["Bash", 2],
      ["Read", 1],
      ["mcp__repo__search_code", 1],
    ],
  )
})

test("干净会话零发现", () => {
  const result = analyze(parseTranscript(read("session-clean.jsonl")))
  assert.equal(result.truncated, 0)
  assert.equal(result.rate, 0)
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.warnings, [])
})

test("文件里没有 tool_result 时给出警告，而不是假装干净", () => {
  const text = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
    JSON.stringify({ type: "attachment", path: "x.png" }),
  ].join("\n")

  const result = analyze(parseTranscript(text))
  assert.equal(result.toolResults, 0)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /may use a transcript format truncgap does not understand/)
})

test("每条发现都带 transcript 行号和 turn，能回查", () => {
  const result = analyze(parseTranscript(read("session-lossy.jsonl")))
  assert.deepEqual(
    result.findings.map((item) => [item.transcriptLine, item.turn, item.tool, item.followUp.kind]),
    [
      [2, 1, "Bash", "retry"],
      [6, 3, "Bash", "unverified"],
      [9, 5, "Read", "retry"],
      [13, 7, "mcp__repo__search_code", "unverified"],
    ],
  )
})

test("--max-follow=0 时不把下一轮的重试算成 recovered", () => {
  const result = analyze(parseTranscript(read("session-lossy.jsonl")), { maxFollow: 0 })
  assert.equal(result.followUp.recovered, 0)
  assert.equal(result.followUp.unverified, 2)
})

test("同工具但结果更短也算重试（没有 limit 之类参数时）", () => {
  const text = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "u1", name: "Grep", input: { pattern: "foo" } },
    ] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "u1", content: "foo\n" + "[500 lines omitted]" },
    ] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "u2", name: "Grep", input: { pattern: "foo", glob: "src/**" } },
    ] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "u2", content: "foo" },
    ] } }),
  ].join("\n")

  const result = analyze(parseTranscript(text))
  assert.equal(result.truncated, 1)
  assert.equal(result.findings[0].followUp.kind, "retry")
})

test("截断后没有重试、也没有断言 → silent", () => {
  const text = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "u1", name: "Bash", input: { command: "cat big.log" } },
    ] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "u1", content: "[truncated]" },
    ] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "text", text: "Moving on to the next file." },
    ] } }),
  ].join("\n")

  const result = analyze(parseTranscript(text))
  assert.equal(result.findings[0].followUp.kind, "silent")
})

test("重试判断优先于结论判断", () => {
  const text = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "u1", name: "Read", input: { file_path: "a.ts" } },
    ] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "u1", content: "showing lines 1-100 of 900" },
    ] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "text", text: "Nothing else there." },
      { type: "tool_use", id: "u2", name: "Read", input: { file_path: "a.ts", offset: 100, limit: 800 } },
    ] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "u2", content: "rest of the file" },
    ] } }),
  ].join("\n")

  const result = analyze(parseTranscript(text))
  assert.equal(result.findings[0].followUp.kind, "retry")
})
