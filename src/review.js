import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  ANTHROPIC_URL,
  BOT_NAME,
  FILE_CAP,
  MAX_MODEL_ATTEMPTS,
  MAX_OUTPUT_TOKENS,
  OPENAI_URL,
  OPENROUTER_URL,
  SKIP_FILES,
  SYSTEM_PROMPT,
  TOTAL_CAP,
  TREE_MAX_LINES,
  geminiUrl,
} from "./config.js"
import { gitLsFiles } from "./git.js"
import { parseModel } from "./models.js"

const VERDICTS = new Set(["approve", "comment", "request_changes"])
const SEVERITIES = new Set(["critical", "warning", "suggestion"])
const SOURCES = new Set(["primary", "secondary", "secondary2", "both"])

/**
 * @typedef {object} ReviewComment
 * @property {string} file
 * @property {number | null} line
 * @property {string | null} line_content
 * @property {"critical" | "warning" | "suggestion"} severity
 * @property {string} trigger
 * @property {string} comment
 * @property {"primary" | "secondary" | "secondary2" | "both"} source
 */

/**
 * @typedef {object} Review
 * @property {string} summary
 * @property {"approve" | "comment" | "request_changes"} verdict
 * @property {ReviewComment[]} comments
 * @property {string} signoff
 */

/**
 * @typedef {object} EngineInput
 * @property {string} diff
 * @property {string} workspace
 * @property {string} [title]
 * @property {string} [body]
 * @property {string} [extraInstructions]
 * @property {string} primaryModel
 * @property {string} secondaryModel
 * @property {string} secondaryModel2
 * @property {import("./models.js").ProviderKeys} keys
 */

/**
 * @typedef {object} InlineComment
 * @property {string} path
 * @property {number} line
 * @property {"RIGHT"} side
 * @property {string} body
 * @property {string} [lineContent]
 */

/**
 * @typedef {object} EngineResult
 * @property {Review} review
 * @property {InlineComment[]} inline
 * @property {string[]} overflow
 * @property {string} body
 * @property {string} primaryModel
 * @property {string} secondaryModel
 * @property {string} secondaryModel2
 */

/**
 * @typedef {object} SecondaryFinding
 * @property {string} model
 * @property {"secondary" | "secondary2"} source
 * @property {Review} review
 */

/**
 * @param {unknown} raw
 * @param {number} index
 * @returns {ReviewComment}
 */
function parseComment(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`comments[${index}] must be an object`)
  }
  const row = /** @type {Record<string, unknown>} */ (raw)
  if (typeof row.file !== "string") throw new Error(`comments[${index}].file must be a string`)
  if (typeof row.comment !== "string") throw new Error(`comments[${index}].comment must be a string`)
  if (!SEVERITIES.has(/** @type {string} */ (row.severity))) {
    throw new Error(`comments[${index}].severity must be critical, warning, or suggestion`)
  }
  const source = row.source === undefined || row.source === "" ? "primary" : row.source
  if (!SOURCES.has(/** @type {string} */ (source))) {
    throw new Error(`comments[${index}].source must be primary, secondary, secondary2, or both`)
  }
  let line = row.line === undefined ? null : row.line
  if (line !== null) {
    if (!Number.isInteger(line) || /** @type {number} */ (line) < 1) {
      throw new Error(`comments[${index}].line must be a positive integer or null`)
    }
  }
  let lineContent = row.line_content === undefined ? null : row.line_content
  if (lineContent !== null && typeof lineContent !== "string") {
    throw new Error(`comments[${index}].line_content must be a string or null`)
  }
  return {
    file: row.file,
    line,
    line_content: lineContent,
    severity: /** @type {ReviewComment["severity"]} */ (row.severity),
    trigger: typeof row.trigger === "string" ? row.trigger : "",
    comment: row.comment,
    source: /** @type {ReviewComment["source"]} */ (source),
  }
}

/**
 * @param {unknown} raw
 * @returns {Review}
 */
export function parseReview(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("review must be an object")
  const row = /** @type {Record<string, unknown>} */ (raw)
  if (typeof row.summary !== "string") throw new Error("summary must be a string")
  if (!VERDICTS.has(/** @type {string} */ (row.verdict))) {
    throw new Error("verdict must be approve, comment, or request_changes")
  }
  const comments = row.comments === undefined ? [] : row.comments
  if (!Array.isArray(comments)) throw new Error("comments must be an array")
  return {
    summary: row.summary,
    verdict: /** @type {Review["verdict"]} */ (row.verdict),
    comments: comments.map(parseComment),
    signoff: typeof row.signoff === "string" ? row.signoff : "",
  }
}

/**
 * @param {string} text
 * @returns {unknown}
 */
export function extractJson(text) {
  const scratchEnd = text.lastIndexOf("</scratch>")
  if (scratchEnd !== -1) text = text.slice(scratchEnd + "</scratch>".length)
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) text = fenced[1]
  text = text.trim()
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start === -1 || end <= start) throw new Error("no JSON object found in reply")
    return JSON.parse(text.slice(start, end + 1))
  }
}

/**
 * @param {string} diff
 * @returns {Map<string, Map<number, string>>}
 */
export function diffNewLines(diff) {
  const files = new Map()
  let file = ""
  let line = 0
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.startsWith("+++ b/") ? raw.slice(6) : ""
      line = 0
      continue
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (!file || line === 0) continue
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      if (!files.has(file)) files.set(file, new Map())
      files.get(file).set(line, raw.slice(1))
      line++
    }
  }
  return files
}

/**
 * @param {string} path
 * @param {number} line
 * @returns {string}
 */
export function fileLineLink(path, line) {
  return `[${path}#L${line}](${path}#L${line})`
}

/**
 * @param {ReviewComment} c
 * @param {Map<string, Map<number, string>>} newLines
 * @returns {number | null}
 */
export function anchorComment(c, newLines) {
  const lines = newLines.get(c.file)
  if (!lines) return null
  const target = c.line_content?.trim()
  if (target) {
    const matches = [...lines].filter(([, text]) => text.trim() === target).map(([n]) => n)
    if (matches.length === 0) return null
    if (c.line !== null && matches.includes(c.line)) return c.line
    if (c.line === null) return matches[0]
    return matches.reduce((a, b) => (Math.abs(b - c.line) < Math.abs(a - c.line) ? b : a))
  }
  if (c.line !== null && lines.has(c.line)) return c.line
  return null
}

/**
 * @param {SecondaryFinding[]} secondaries
 * @returns {string}
 */
export function secondaryFindingsSection(secondaries) {
  if (!secondaries.length) return ""
  const blocks = secondaries.flatMap((item) => [
    `### ${item.model} (use source "${item.source}" for findings that originated only here)`,
    "```json",
    JSON.stringify(item.review.comments, null, 2),
    "```",
  ])
  return [
    "\n\n## Other reviewers' findings",
    "IMPORTANT: First complete your OWN independent review in your <scratch> block, WITHOUT consulting the lists below. Only then compare against these findings:",
    '- A finding below that duplicates one of yours (same underlying issue, even if worded or located slightly differently): keep YOUR version, set its `source` to "both".',
    '- A finding below that is genuinely new AND that you verify is a real issue: include it as your own comment (re-anchor file/line/line_content yourself), set `source` to "secondary" or "secondary2" as labeled.',
    "- A finding below that is wrong or not worth raising: drop it silently.",
    '- Your own findings not in the list: `source` "primary".',
    "Recompute summary and verdict over the final merged comment set.",
    ...blocks,
  ].join("\n")
}

/**
 * @param {string} diff
 * @returns {string[]}
 */
export function changedFiles(diff) {
  return [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]))]
}

/**
 * @param {number} status
 * @returns {boolean}
 */
function shouldRetryStatus(status) {
  return status === 408 || status >= 500
}

/**
 * @param {string} spec
 * @param {import("./models.js").ProviderKeys} keys
 * @param {string} userContent
 * @param {string} [extraInstructions]
 * @returns {Promise<Review>}
 */
async function callModel(spec, keys, userContent, extraInstructions) {
  const { provider, id } = parseModel(spec)
  const apiKey = keys[provider]
  if (!apiKey) throw new Error(`${provider} API key missing`)
  const extra = extraInstructions?.trim()
  const systemPrompt = extra ? `${SYSTEM_PROMPT}\n\nProject-specific guidance:\n${extra}` : SYSTEM_PROMPT
  const retryNote = (err) => `That was not valid JSON for the schema (${err}). Reply with ONLY the JSON object.`
  /** @type {{ role: string, content: string }[]} */
  const initialChat = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ]
  /** @type {{ role: string, content: string }[]} */
  const initialAnthropic = [{ role: "user", content: userContent }]
  /** @type {{ role: string, parts: { text: string }[] }[]} */
  const initialGemini = [{ role: "user", parts: [{ text: userContent }] }]
  let chatMessages = initialChat
  let anthropicMessages = initialAnthropic
  let geminiContents = initialGemini
  let lastError
  for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
    let res
    try {
      res = await fetchProvider(provider, id, apiKey, systemPrompt, chatMessages, anthropicMessages, geminiContents)
    } catch (e) {
      lastError = e
      continue
    }
    if (!res.ok) {
      lastError = new Error(formatHttpError(provider, res.status, await res.text()))
      if (!shouldRetryStatus(res.status)) throw lastError
      continue
    }
    let json
    try {
      json = await res.json()
    } catch (e) {
      lastError = e
      continue
    }
    const text = replyText(provider, json)
    if (!text.trim()) {
      lastError = new Error("empty model reply")
      chatMessages = initialChat
      anthropicMessages = initialAnthropic
      geminiContents = initialGemini
      continue
    }
    try {
      return parseReview(extractJson(text))
    } catch (e) {
      lastError = e
      const note = retryNote(e)
      chatMessages = [...chatMessages, { role: "assistant", content: text }, { role: "user", content: note }]
      anthropicMessages = [...anthropicMessages, { role: "assistant", content: text }, { role: "user", content: note }]
      geminiContents = [
        ...geminiContents,
        { role: "model", parts: [{ text }] },
        { role: "user", parts: [{ text: note }] },
      ]
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error(`Model ${spec} failed after ${MAX_MODEL_ATTEMPTS} attempts`)
}

/**
 * @param {number} status
 * @returns {string}
 */
function statusReason(status) {
  if (status === 400) return "bad request"
  if (status === 401 || status === 403) return "unauthorized"
  if (status === 404) return "not found"
  if (status === 408 || status === 504) return "timed out"
  if (status === 429) return "rate limited"
  if (status >= 500) return "server error"
  return "request failed"
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
  const line = String(text).replace(/\s+/g, " ").trim()
  if (!line) return ""
  const cut = line.search(/[.!?](\s|$)/)
  const sentence = cut === -1 ? line : line.slice(0, cut + 1)
  return sentence.length > 180 ? `${sentence.slice(0, 177)}...` : sentence
}

/**
 * @param {string} body
 * @returns {string}
 */
export function summarizeErrorBody(body) {
  const text = String(body || "").trim()
  if (!text) return ""
  try {
    const json = JSON.parse(text)
    const err = json.error && typeof json.error === "object" ? json.error : json
    const raw = typeof err.metadata?.raw === "string" ? err.metadata.raw.trim() : ""
    const message = typeof err.message === "string" ? err.message.trim() : ""
    const generic = !message || /^provider returned error$/i.test(message)
    if (raw && !raw.startsWith("{") && !raw.startsWith("[")) return firstSentence(raw)
    if (!generic) return firstSentence(message)
  } catch {
    if (text.startsWith("{") || text.startsWith("[")) return ""
    return firstSentence(text)
  }
  return ""
}

/**
 * @param {import("./models.js").Provider} provider
 * @param {number} status
 * @param {string} body
 * @returns {string}
 */
export function formatHttpError(provider, status, body) {
  const detail = summarizeErrorBody(body)
  const prefix = `${providerLabel(provider)} ${status} (${statusReason(status)})`
  return detail ? `${prefix}: ${detail}` : prefix
}

/**
 * @param {import("./models.js").Provider} provider
 * @returns {string}
 */
function providerLabel(provider) {
  if (provider === "anthropic") return "Anthropic"
  if (provider === "openai") return "OpenAI"
  if (provider === "gemini") return "Gemini"
  return "OpenRouter"
}

/**
 * @param {import("./models.js").Provider} provider
 * @param {string} id
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {{ role: string, content: string }[]} chatMessages
 * @param {{ role: string, content: string }[]} anthropicMessages
 * @param {{ role: string, parts: { text: string }[] }[]} geminiContents
 * @returns {Promise<Response>}
 */
function fetchProvider(provider, id, apiKey, systemPrompt, chatMessages, anthropicMessages, geminiContents) {
  if (provider === "anthropic") {
    return fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: id,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages: anthropicMessages,
      }),
    })
  }
  if (provider === "gemini") {
    return fetch(geminiUrl(id), {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: geminiContents,
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
    })
  }
  const url = provider === "openai" ? OPENAI_URL : OPENROUTER_URL
  const limit = provider === "openai" ? { max_completion_tokens: MAX_OUTPUT_TOKENS } : { max_tokens: MAX_OUTPUT_TOKENS }
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: id, messages: chatMessages, ...limit }),
  })
}

/**
 * @param {import("./models.js").Provider} provider
 * @param {any} json
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      return typeof part?.text === "string" ? part.text : ""
    })
    .join("")
}

function replyText(provider, json) {
  if (provider === "anthropic") {
    const blocks = Array.isArray(json.content) ? json.content : []
    return contentText(blocks)
  }
  if (provider === "gemini") {
    const parts = json.candidates?.[0]?.content?.parts || []
    return contentText(parts)
  }
  return contentText(json.choices?.[0]?.message?.content)
}

/**
 * @param {string} workspace
 * @returns {string}
 */
function repoTree(workspace) {
  try {
    const files = gitLsFiles(workspace)
    let tree = files.slice(0, TREE_MAX_LINES).join("\n")
    if (files.length > TREE_MAX_LINES) tree += `\n… (${files.length - TREE_MAX_LINES} more files not shown)`
    return tree
  } catch {
    return ""
  }
}

/**
 * @param {string} diff
 * @param {string} workspace
 * @returns {string}
 */
function changedFileSections(diff, workspace) {
  let budget = TOTAL_CAP
  const fileSections = []
  for (const f of changedFiles(diff)) {
    if (SKIP_FILES.test(f)) continue
    const p = join(workspace, f)
    if (!existsSync(p)) continue
    let content
    try {
      content = readFileSync(p, "utf8")
    } catch {
      continue
    }
    if (content.length > FILE_CAP) content = content.slice(0, FILE_CAP) + "\n… (truncated)"
    if (content.length > budget) {
      fileSections.push(`--- ${f} (contents omitted: prompt budget)`)
      continue
    }
    budget -= content.length
    fileSections.push(`--- ${f}\n${content}`)
  }
  return fileSections.join("\n\n")
}

/**
 * @param {{ diff: string, workspace: string, title?: string, body?: string }} input
 * @returns {string}
 */
export function buildUserContent(input) {
  const heading = [input.title, input.body].filter((part) => part != null && String(part).length).join("\n")
  return [
    heading || "Branch review",
    `## Repo file tree\n${repoTree(input.workspace)}`,
    `## Diff\n\`\`\`diff\n${input.diff}\n\`\`\``,
    `## Full contents of changed files\n${changedFileSections(input.diff, input.workspace)}`,
  ].join("\n\n")
}

/**
 * @param {Review} review
 * @param {string[]} overflow
 * @returns {string}
 */
export function formatReviewBody(review, overflow) {
  const emoji = { approve: "✅", comment: "💬", request_changes: "🛑" }[review.verdict]
  let body = `## ${emoji} ${BOT_NAME} — ${review.verdict.replace("_", " ")}\n\n${review.summary}`
  if (overflow.length) body += `\n\n### Notes on lines outside the diff\n${overflow.join("\n")}`
  if (review.signoff) body += `\n\n*${review.signoff}*`
  return body
}

const FENCE_LANG = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  css: "css",
  html: "html",
  sql: "sql",
}

/**
 * @param {string} path
 * @returns {string}
 */
function fenceLanguage(path) {
  const base = path.split("/").pop() || path
  const dot = base.lastIndexOf(".")
  const ext = dot === -1 ? "" : base.slice(dot + 1).toLowerCase()
  return FENCE_LANG[ext] || ext
}

/**
 * @param {string} lang
 * @param {string} code
 * @returns {string}
 */
function codeFence(lang, code) {
  const longest = (code.match(/`+/g) || []).reduce((n, s) => Math.max(n, s.length), 0)
  const ticks = "`".repeat(Math.max(3, longest + 1))
  return `${ticks}${lang}\n${code}\n${ticks}`
}

/**
 * @param {EngineResult} result
 * @returns {string}
 */
export function formatCliOutput(result) {
  const parts = [result.body]
  if (!result.inline.length) return parts.join("\n")

  /** @type {string[]} */
  const order = []
  /** @type {Map<string, InlineComment[]>} */
  const groups = new Map()
  for (const c of result.inline) {
    if (!groups.has(c.path)) {
      groups.set(c.path, [])
      order.push(c.path)
    }
    groups.get(c.path).push(c)
  }

  for (const path of order) {
    for (const c of groups.get(path)) {
      parts.push("", "---", "", fileLineLink(path, c.line))
      if (c.lineContent) parts.push("", codeFence(fenceLanguage(path), c.lineContent))
      parts.push("", c.body)
    }
  }
  return parts.join("\n")
}

/**
 * @param {EngineInput} input
 * @returns {Promise<EngineResult>}
 */
export async function runReview(input) {
  const userContent = buildUserContent(input)
  const extra = input.extraInstructions

  /**
   * @param {string} preferred
   * @param {"primary" | "secondary" | "secondary2"} source
   * @param {string} content
   * @returns {Promise<{ model: string, review: Review, source?: "secondary" | "secondary2" } | null>}
   */
  async function runSlot(preferred, source, content) {
    if (!preferred.trim()) return null
    const label = source === "primary" ? "Reviewing" : "Secondary review"
    console.log(`${label} with ${preferred} (prompt ~${content.length} chars)`)
    try {
      const review = await callModel(preferred, input.keys, content, extra)
      return source === "primary" ? { model: preferred, review } : { model: preferred, source, review }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.warn(`Model ${preferred} failed: ${message}`)
      if (source === "primary") throw e instanceof Error ? e : new Error(message)
      console.warn(`Secondary slot ${source} failed, continuing without it`)
      return null
    }
  }

  /** @type {{ model: string, source: "secondary" | "secondary2" }[]} */
  const slots = []
  if (input.secondaryModel && input.secondaryModel !== input.primaryModel) {
    slots.push({ model: input.secondaryModel, source: "secondary" })
  }
  if (
    input.secondaryModel2 &&
    input.secondaryModel2 !== input.primaryModel &&
    input.secondaryModel2 !== input.secondaryModel
  ) {
    slots.push({ model: input.secondaryModel2, source: "secondary2" })
  }

  /** @type {SecondaryFinding[]} */
  const secondaries = (
    await Promise.all(slots.map((slot) => runSlot(slot.model, slot.source, userContent)))
  ).filter((item) => item !== null && item.source)

  const primaryContent = secondaries.length ? userContent + secondaryFindingsSection(secondaries) : userContent
  const primary = await runSlot(input.primaryModel, "primary", primaryContent)
  if (!primary) throw new Error("Primary model call failed")
  const review = primary.review
  const primaryModel = primary.model
  const secondaryByUsed = Object.fromEntries(secondaries.map((item) => [item.source, item.model]))

  const newLines = diffNewLines(input.diff)
  /** @type {InlineComment[]} */
  const inline = []
  /** @type {string[]} */
  const overflow = []
  for (const c of review.comments) {
    let commentBody = `**${c.severity}**: ${c.comment}`
    if (c.trigger) commentBody += `\n\n_Trigger:_ ${c.trigger}`
    if (secondaries.length) {
      const flagged =
        c.source === "primary"
          ? primaryModel
          : c.source === "both"
            ? [primaryModel, ...secondaries.map((s) => s.model)].join(", ")
            : secondaryByUsed[c.source] || c.source
      commentBody += `\n\n_Flagged by: ${flagged}_`
    }
    const line = anchorComment(c, newLines)
    if (line !== null) {
      const lineContent = newLines.get(c.file)?.get(line) ?? c.line_content ?? ""
      inline.push({
        path: c.file,
        line,
        side: "RIGHT",
        body: commentBody,
        lineContent,
      })
    } else {
      const loc = c.line !== null ? fileLineLink(c.file, c.line) : `\`${c.file}\``
      overflow.push(`- ${loc} ${commentBody.replace(/\n+/g, " ")}`)
    }
  }

  return {
    review,
    inline,
    overflow,
    body: formatReviewBody(review, overflow),
    primaryModel,
    secondaryModel: secondaryByUsed.secondary || "",
    secondaryModel2: secondaryByUsed.secondary2 || "",
  }
}
