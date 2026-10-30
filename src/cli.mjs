#!/usr/bin/env node
/**
 * truncgap CLI
 *
 *   truncgap scan <transcript.jsonl> [--json] [--fail-on=loss|unverified] [--max-follow=6]
 *
 * 退出码：
 *   0 通过   1 命中 --fail-on   2 参数错误   3 输入读不了
 */
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { analyze } from "./analyze.mjs"
import { formatScan } from "./report.mjs"
import { parseTranscript, TranscriptError } from "./session.mjs"

export const VERSION = "0.1.0"

export const EXIT_CODES = Object.freeze({
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  INPUT: 3,
})

const COMMANDS = new Map([["scan", "扫描一份会话 transcript"]])

const FAIL_ON = ["loss", "unverified"]
const OPTION_KEYS = ["help", "json", "fail-on", "max-follow"]

export class CliError extends Error {
  constructor(message, { code = "E_USAGE", exitCode = EXIT_CODES.USAGE } = {}) {
    super(message)
    this.name = "CliError"
    this.code = code
    this.exitCode = exitCode
  }
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const [first, ...rest] = argv
  if (!first || first === "-h" || first === "--help") return { command: "help", options: {}, target: undefined }
  if (first.startsWith("-")) throw new CliError(`未知选项：${first}`)
  if (!COMMANDS.has(first)) throw new CliError(`未知命令：${first}`)

  const options = {}
  const positionals = []

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]

    if (token === "-h" || token === "--help") {
      options.help = true
      continue
    }
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }

    const body = token.slice(2)
    const equals = body.indexOf("=")
    const key = equals === -1 ? body : body.slice(0, equals)
    if (!OPTION_KEYS.includes(key)) throw new CliError(`${first} 不支持选项：--${key}`)

    if (equals !== -1) {
      options[key] = body.slice(equals + 1)
      continue
    }
    if (key === "help" || key === "json") {
      options[key] = true
      continue
    }

    const next = rest[index + 1]
    if (next === undefined || next.startsWith("--")) throw new CliError(`选项 --${key} 缺少值`)
    options[key] = next
    index += 1
  }

  if (positionals.length > 1) throw new CliError(`多余的参数：${positionals[1]}`)
  return { command: first, options, target: positionals[0] }
}

/**
 * @param {{ command: string, options: Record<string, string | boolean>, target?: string }} parsed
 * @param {{ read?: (target: string) => string }} [deps]
 */
export function execute(parsed, deps = {}) {
  const { command, options, target } = parsed

  if (command === "help" || options.help) return { kind: "help", payload: helpPayload() }
  if (command !== "scan") throw new CliError(`未知命令：${command}`)
  if (!target) throw new CliError("scan 需要一个 transcript 文件路径（或用 - 从 stdin 读）")

  const failOn = normalizeFailOn(options["fail-on"])
  const maxFollow = normalizeMaxFollow(options["max-follow"])

  const read = deps.read ?? readSource
  let raw
  try {
    raw = read(target)
  } catch (error) {
    throw new CliError(`读不了 ${target}：${error.message}`, { code: "E_INPUT", exitCode: EXIT_CODES.INPUT })
  }

  const parsedTranscript = parseTranscript(raw, { file: target === "-" ? "stdin" : target })
  const result = analyze(parsedTranscript, { maxFollow })

  const failed =
    failOn === "loss" ? result.truncated > 0 : failOn === "unverified" ? result.followUp.unverified > 0 : false

  return { kind: "scan", result, failOn, failed }
}

function normalizeFailOn(raw) {
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || !FAIL_ON.includes(raw)) {
    throw new CliError(`--fail-on 只能是 ${FAIL_ON.join(" / ")}`)
  }
  return raw
}

function normalizeMaxFollow(raw) {
  if (raw === undefined) return 6
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new CliError("--max-follow 需要 0-1000 的整数")
  }
  return value
}

function readSource(target) {
  if (target === "-") return readFileSync(0, "utf8")
  return readFileSync(target, "utf8")
}

/**
 * @param {string[]} argv
 * @param {{ log: (line: string) => void, error: (line: string) => void }} io
 * @param {{ read?: (target: string) => string }} [deps]
 */
export function main(argv = process.argv.slice(2), io = console, deps = {}) {
  try {
    const parsed = parseArgs(argv)
    const asJson = parsed.options.json === true
    const outcome = execute(parsed, deps)

    if (outcome.kind === "help") {
      io.log(JSON.stringify(outcome.payload, null, 2))
      return EXIT_CODES.OK
    }

    const { result, failOn, failed } = outcome
    if (asJson) io.log(JSON.stringify(toJson(result, failOn, failed), null, 2))
    else io.log(formatScan(result, { failOn, failed, version: VERSION }))
    return failed ? EXIT_CODES.FAIL : EXIT_CODES.OK
  } catch (error) {
    if (error instanceof CliError) {
      io.error(`truncgap: ${error.message}`)
      return error.exitCode
    }
    if (error instanceof TranscriptError) {
      io.error(`truncgap: ${error.message}`)
      return EXIT_CODES.INPUT
    }
    io.error(`truncgap: internal error: ${error.message}`)
    return EXIT_CODES.INPUT
  }
}

/**
 * @param {ReturnType<typeof analyze>} result
 */
export function toJson(result, failOn, failed) {
  return {
    ...result,
    gate: { failOn: failOn ?? null, failed },
  }
}

function helpPayload() {
  return {
    name: "truncgap",
    version: VERSION,
    usage: "truncgap scan <transcript.jsonl|-> [options]",
    commands: [...COMMANDS].map(([name, description]) => ({ name, description })),
    options: [
      { flag: "--json", description: "输出 JSON" },
      { flag: "--fail-on=loss", description: "有截断就 exit 1" },
      { flag: "--fail-on=unverified", description: "出现「截断后直接下结论」就 exit 1" },
      { flag: "--max-follow=<n>", description: "重试关联窗口，默认 6 轮" },
    ],
    exitCodes: [
      { code: EXIT_CODES.OK, meaning: "通过" },
      { code: EXIT_CODES.FAIL, meaning: "命中 --fail-on" },
      { code: EXIT_CODES.USAGE, meaning: "参数或命令错误" },
      { code: EXIT_CODES.INPUT, meaning: "输入读不了或格式不支持" },
    ],
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2))
}
