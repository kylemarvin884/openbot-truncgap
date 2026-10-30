import assert from "node:assert/strict"
import test from "node:test"
import { detectTruncation, HARD_CAPS } from "../src/detect.mjs"

test("显式行数省略", () => {
  const hit = detectTruncation("src/a.ts:1: foo\n...\n[1,234 lines omitted]")
  assert.equal(hit.kind, "marked")
  assert.equal(hit.lostLines, 1234)
  assert.match(hit.evidence, /1,234 lines omitted/)
})

test("showing lines A-B of TOTAL 计算缺失行数", () => {
  const hit = detectTruncation("showing lines 1-2000 of 4120\nimport x from 'y'")
  assert.equal(hit.kind, "marked")
  assert.equal(hit.lostLines, 2120)
  assert.match(hit.evidence, /lines 2,001-4,120 missing/)
})

test("first N of M results", () => {
  const hit = detectTruncation("first 3 of 118 results shown")
  assert.equal(hit.kind, "marked")
  assert.equal(hit.lostLines, 115)
})

test("有标记但没有计数：不给假数字", () => {
  const hit = detectTruncation("FAIL one test\n...\noutput truncated")
  assert.equal(hit.kind, "marked")
  assert.equal(hit.lostLines, 0)
  assert.match(hit.evidence, /no count/)
})

test("truncated to N chars", () => {
  const hit = detectTruncation("log head ... truncated to 8,000 chars")
  assert.equal(hit.kind, "marked")
  assert.match(hit.evidence, /8,000 chars/)
})

test("长度正好撞上整数上限：标为可疑，且不算 marked", () => {
  assert.ok(HARD_CAPS.includes(30000))
  const hit = detectTruncation("x".repeat(30000))
  assert.equal(hit.kind, "hardcap")
  assert.equal(hit.suspectedCap, true)
  assert.match(hit.evidence, /30,000 chars = common hard cap/)
})

test("被切断的 JSON", () => {
  const hit = detectTruncation('{"results":[{"path":"src/a.ts","line":12,"text":"await withRetry(fn, 3)"},{"path":"src/b')
  assert.equal(hit.kind, "cutjson")
})

test("完整输出不误报", () => {
  assert.equal(detectTruncation("3 files changed, 12 insertions(+), 4 deletions(-)"), null)
  assert.equal(detectTruncation('{"ok":true,"items":[1,2,3],"note":"' + "y".repeat(200) + '"}'), null)
  assert.equal(detectTruncation(""), null)
  assert.equal(detectTruncation(null), null)
})

test("提到 truncate 的普通文本不误报", () => {
  assert.equal(detectTruncation("renamed the helper to truncateLines and updated the callers"), null)
  assert.equal(detectTruncation("pass --truncate to enable it"), null)
})
