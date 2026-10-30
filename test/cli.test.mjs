import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { EXIT_CODES, main, parseArgs } from "../src/cli.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const lossy = readFileSync(join(here, "..", "demo", "session-lossy.jsonl"), "utf8")
const clean = readFileSync(join(here, "..", "demo", "session-clean.jsonl"), "utf8")

function run(argv, { read } = {}) {
  const out = []
  const err = []
  const code = main(argv, { log: (line) => out.push(line), error: (line) => err.push(line) }, {
    read: read ?? (() => lossy),
  })
  return { code, out: out.join("\n"), err: err.join("\n") }
}

test("scan 正常输出表格，退出码 0", () => {
  const { code, out } = run(["scan", "session.jsonl"])
  assert.equal(code, EXIT_CODES.OK)
  assert.match(out, /truncgap 0\.1\.0/)
  assert.match(out, /truncated 4 \(67%\)/)
  assert.match(out, /1,234 lines omitted/)
  assert.match(out, /2 recovered · 2 unverified conclusions · 0 silent/)
})

test("--fail-on=loss 命中时退出码 1", () => {
  const { code, out } = run(["scan", "session.jsonl", "--fail-on=loss"])
  assert.equal(code, EXIT_CODES.FAIL)
  assert.match(out, /exit 1 \(--fail-on=loss\)/)
})

test("--fail-on=loss 在干净会话上退出码 0", () => {
  const { code } = run(["scan", "clean.jsonl", "--fail-on=loss"], { read: () => clean })
  assert.equal(code, EXIT_CODES.OK)
})

test("--fail-on=unverified 只看「截断后下结论」", () => {
  const { code } = run(["scan", "session.jsonl", "--fail-on=unverified"])
  assert.equal(code, EXIT_CODES.FAIL)

  const cleanRun = run(["scan", "clean.jsonl", "--fail-on=unverified"], { read: () => clean })
  assert.equal(cleanRun.code, EXIT_CODES.OK)
})

test("--fail-on 支持空格写法", () => {
  const parsed = parseArgs(["scan", "a.jsonl", "--fail-on", "unverified"])
  assert.equal(parsed.options["fail-on"], "unverified")
  assert.equal(parsed.target, "a.jsonl")
})

test("--json 输出可解析，并带 gate", () => {
  const { code, out } = run(["scan", "session.jsonl", "--json", "--fail-on=loss"])
  assert.equal(code, EXIT_CODES.FAIL)
  const payload = JSON.parse(out)
  assert.equal(payload.schema, "truncgap/1")
  assert.equal(payload.truncated, 4)
  assert.deepEqual(payload.gate, { failOn: "loss", failed: true })
  assert.equal(payload.findings[0].followUp.kind, "retry")
})

test("参数错误退出码 2", () => {
  for (const argv of [["nope"], ["scan"], ["scan", "a.jsonl", "--fail-on=everything"], ["scan", "a.jsonl", "--max-follow=abc"], ["scan", "a.jsonl", "--unknown"]]) {
    const { code, err } = run(argv)
    assert.equal(code, EXIT_CODES.USAGE, `argv: ${argv.join(" ")}`)
    assert.match(err, /^truncgap: /)
  }
})

test("读不到文件退出码 3", () => {
  const { code, err } = run(["scan", "missing.jsonl"], {
    read: () => {
      throw new Error("ENOENT: no such file")
    },
  })
  assert.equal(code, EXIT_CODES.INPUT)
  assert.match(err, /读不了 missing\.jsonl/)
})

test("格式不对退出码 3", () => {
  const { code, err } = run(["scan", "broken.jsonl"], { read: () => "{oops" })
  assert.equal(code, EXIT_CODES.INPUT)
  assert.match(err, /不是合法 JSON/)
})

test("help 输出用法与退出码表", () => {
  const { code, out } = run(["--help"])
  assert.equal(code, EXIT_CODES.OK)
  const payload = JSON.parse(out)
  assert.match(payload.usage, /truncgap scan/)
  assert.equal(payload.exitCodes.length, 4)
})
