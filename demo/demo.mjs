/**
 * demo：同一份逻辑跑两份 fixture。
 *   session-clean.jsonl  —— 正常会话，不该报截断
 *   session-lossy.jsonl  —— 到处是截断，其中两处在截断后直接下了结论
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { analyze } from "../src/analyze.mjs"
import { formatScan } from "../src/report.mjs"
import { parseTranscript } from "../src/session.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = ["session-clean.jsonl", "session-lossy.jsonl"]

for (const name of fixtures) {
  const file = join(here, name)
  const parsed = parseTranscript(readFileSync(file, "utf8"), { file: `demo/${name}` })
  const result = analyze(parsed)

  console.log("=".repeat(72))
  console.log(formatScan(result, { version: "0.1.0" }))
  console.log(
    `gate: --fail-on=loss -> ${result.truncated > 0 ? 1 : 0}   ` +
      `--fail-on=unverified -> ${result.followUp.unverified > 0 ? 1 : 0}`,
  )
  console.log("")
}
