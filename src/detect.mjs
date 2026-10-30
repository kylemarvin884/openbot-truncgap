/**
 * 截断检测：只做确定性的文本判断，不猜。
 *
 * 三类证据：
 *   marked    —— 输出里自带截断标记，丢失量有时能算出来
 *   hardcap   —— 长度正好撞上常见整数上限（危险：没有任何提示）
 *   cutjson   —— 以 { 或 [ 开头但 JSON 解析失败（被硬切）
 */

/** 常见输出上限（字符数）。命中只算「可疑」，不当成事实。 */
export const HARD_CAPS = Object.freeze([4000, 8000, 10000, 16000, 20000, 25000, 30000, 32000, 50000, 65535, 65536, 100000])

const CUT_JSON_MIN_LENGTH = 40

/**
 * @typedef {object} Detection
 * @property {"marked"|"hardcap"|"cutjson"} kind
 * @property {string} evidence 给人看的一行说明
 * @property {number} lostLines 能确定的行数，0 表示未知
 * @property {number} lostChars 能确定的字符数，0 表示未知
 */

const MARKERS = [
  {
    re: /\[\s*\.\.\.\s*(\d[\d,]*)\s+(?:lines?|rows?)\s+omitted\s*\.\.\.\s*\]/i,
    build: (m) => ({ evidence: `${count(m[1])} lines omitted (marked)`, lostLines: count(m[1]) }),
  },
  {
    re: /showing\s+(?:first\s+)?(?:lines?\s+)?(\d[\d,]*)\s*[-–—]\s*(\d[\d,]*)\s+of\s+(\d[\d,]*)/i,
    build: (m) => {
      const first = count(m[1])
      const shownTo = count(m[2])
      const total = count(m[3])
      const missing = Math.max(0, total - shownTo)
      return {
        evidence: `lines ${fmt(shownTo + 1)}-${fmt(total)} missing (marked)`,
        lostLines: missing,
        detail: `showed ${fmt(first)}-${fmt(shownTo)} of ${fmt(total)}`,
      }
    },
  },
  {
    re: /(?:first|only)\s+(\d[\d,]*)\s+of\s+(\d[\d,]*)\s+(?:lines?|rows?|matches|results)/i,
    build: (m) => {
      const shown = count(m[1])
      const total = count(m[2])
      return { evidence: `${fmt(Math.max(0, total - shown))} of ${fmt(total)} lines not shown (marked)`, lostLines: Math.max(0, total - shown) }
    },
  },
  {
    re: /(\d[\d,]*)\s+(?:lines?|rows?)\s+(?:omitted|truncated|hidden|skipped|not shown)/i,
    build: (m) => ({ evidence: `${fmt(count(m[1]))} lines omitted (marked)`, lostLines: count(m[1]) }),
  },
  {
    re: /truncated\s+to\s+(\d[\d,]*)\s+(characters?|chars?|bytes?|tokens?)/i,
    build: (m) => ({ evidence: `truncated to ${fmt(count(m[1]))} ${m[2].toLowerCase()} (marked)`, lostLines: 0 }),
  },
  {
    re: /\.\.\.\s*and\s+(\d[\d,]*)\s+more/i,
    build: (m) => ({ evidence: `${fmt(count(m[1]))} more items not shown (marked)`, lostLines: count(m[1]) }),
  },
  {
    re: /\b(?:output|response|result|stdout|stderr)\s+(?:was\s+|has\s+been\s+)?truncated\b/i,
    build: () => ({ evidence: "output truncated, no count (marked)", lostLines: 0 }),
  },
  {
    re: /\boutput limit exceeded\b|\bmax_output_(?:chars|tokens)\b|\bexceeds?\s+the\s+maximum\s+output\b/i,
    build: () => ({ evidence: "hit an output limit (marked)", lostLines: 0 }),
  },
  {
    re: /\bcharacters?\s+omitted\b/i,
    build: () => ({ evidence: "characters omitted, no count (marked)", lostLines: 0 }),
  },
  {
    re: /\[\s*truncated\s*\]|<truncated>|\(truncated\)/i,
    build: () => ({ evidence: "truncation marker, no count (marked)", lostLines: 0 }),
  },
]

/**
 * @param {string} text tool result 的正文
 * @returns {Detection | null}
 */
export function detectTruncation(text) {
  if (typeof text !== "string" || text === "") return null

  for (const marker of MARKERS) {
    const match = marker.re.exec(text)
    if (!match) continue
    const built = marker.build(match)
    return {
      kind: "marked",
      evidence: built.evidence,
      lostLines: built.lostLines ?? 0,
      lostChars: built.lostChars ?? 0,
      detail: built.detail,
    }
  }

  if (HARD_CAPS.includes(text.length)) {
    return {
      kind: "hardcap",
      evidence: `length ${fmt(text.length)} chars = common hard cap (unmarked)`,
      lostLines: 0,
      lostChars: 0,
      suspectedCap: true,
    }
  }

  const trimmed = text.trimStart()
  if (
    trimmed.length >= CUT_JSON_MIN_LENGTH &&
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    !isParsableJson(trimmed)
  ) {
    return {
      kind: "cutjson",
      evidence: "payload is cut JSON, does not parse (unmarked)",
      lostLines: 0,
      lostChars: 0,
    }
  }

  return null
}

function fmt(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function count(raw) {
  const value = Number(String(raw).replaceAll(",", ""))
  return Number.isFinite(value) ? value : 0
}

function isParsableJson(text) {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
