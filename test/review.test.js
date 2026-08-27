import { test } from "node:test"
import assert from "node:assert/strict"
import { ANTHROPIC_URL, MAX_OUTPUT_TOKENS, OPENAI_URL, OPENROUTER_URL, ZAI_URL, geminiUrl } from "../src/config.js"
import {
  diffNewLines,
  anchorComment,
  changedFiles,
  extractJson,
  secondaryFindingsSection,
  parseReview,
  formatCliOutput,
  formatHttpError,
  summarizeErrorBody,
  runReview,
} from "../src/review.js"

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const x = 1
+const y = 2
 const z = 3
 export { x, z }
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-old
-old2
`

test("diffNewLines maps additions and context on the new side with content", () => {
  const files = diffNewLines(DIFF)
  const a = files.get("src/a.ts")
  assert.equal(a.get(1), "const x = 1")
  assert.equal(a.get(2), "const y = 2")
  assert.equal(a.get(4), "export { x, z }")
  assert.ok(!a.has(5))
  assert.ok(!files.has("gone.ts"))
})

test("changedFiles skips deleted files", () => {
  assert.deepEqual(changedFiles(DIFF), ["src/a.ts"])
})

const base = { severity: "warning", trigger: "", comment: "c", line_content: null, line: null, source: "primary" }

test("anchorComment prefers line_content over a conflicting line number", () => {
  const files = diffNewLines(DIFF)
  assert.equal(anchorComment({ ...base, file: "src/a.ts", line: 2 }, files), 2)
  assert.equal(anchorComment({ ...base, file: "src/a.ts", line: 99, line_content: "const y = 2" }, files), 2)
  assert.equal(anchorComment({ ...base, file: "src/a.ts", line: 1, line_content: "const y = 2" }, files), 2)
  assert.equal(anchorComment({ ...base, file: "src/a.ts", line_content: "  const z = 3  " }, files), 3)
  assert.equal(anchorComment({ ...base, file: "src/a.ts", line: 1, line_content: "nope" }, files), null)
  assert.equal(anchorComment({ ...base, file: "src/a.ts", line: 99, line_content: "nope" }, files), null)
  assert.equal(anchorComment({ ...base, file: "other.ts", line: 1 }, files), null)
})

test("parseReview defaults source to primary, accepts secondary/secondary2/both", () => {
  const parsed = parseReview({
    summary: "s",
    verdict: "comment",
    comments: [
      { file: "a.ts", severity: "warning", comment: "no source" },
      { file: "a.ts", severity: "warning", comment: "from qwen", source: "secondary" },
      { file: "a.ts", severity: "warning", comment: "from llama", source: "secondary2" },
      { file: "a.ts", severity: "warning", comment: "agreed", source: "both" },
    ],
  })
  assert.deepEqual(
    parsed.comments.map((c) => c.source),
    ["primary", "secondary", "secondary2", "both"]
  )
})

test("secondaryFindingsSection embeds both reviewers, ordering instruction, and findings JSON", () => {
  const secondary = parseReview({
    summary: "s",
    verdict: "comment",
    comments: [{ file: "a.ts", line: 2, severity: "critical", comment: "off-by-one" }],
  })
  const secondary2 = parseReview({
    summary: "s",
    verdict: "comment",
    comments: [{ file: "a.ts", line: 3, severity: "warning", comment: "null-deref" }],
  })
  const section = secondaryFindingsSection([
    { model: "qwen/qwen3.7-flash", source: "secondary", review: secondary },
    { model: "openai/gpt-oss-120b:free", source: "secondary2", review: secondary2 },
  ])
  assert.ok(section.includes("qwen/qwen3.7-flash"))
  assert.ok(section.includes("openai/gpt-oss-120b:free"))
  assert.ok(section.includes("OWN independent review"))
  assert.ok(section.includes('"off-by-one"'))
  assert.ok(section.includes('"null-deref"'))
  assert.ok(section.includes('source "secondary2"'))
})

test("extractJson handles scratch blocks, fences, bare JSON, and stray prose", () => {
  assert.deepEqual(extractJson('<scratch>{"fake":1} thinking...</scratch>\n{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson(' {"a":1} '), { a: 1 })
  assert.deepEqual(extractJson('Here is the review:\n{"a":1}\nDone.'), { a: 1 })
})

test("formatCliOutput uses path#Lline links and quoted lines", () => {
  const out = formatCliOutput({
    review: parseReview({ summary: "ok", verdict: "comment" }),
    inline: [
      { path: "src/a.ts", line: 2, side: "RIGHT", body: "**warning**: x", lineContent: "const y = 2" },
      { path: "src/a.ts", line: 4, side: "RIGHT", body: "**suggestion**: y", lineContent: "export { x, z }" },
      { path: "src/b.js", line: 1, side: "RIGHT", body: "**critical**: z", lineContent: "module.exports = 1" },
    ],
    overflow: [],
    body: "## body",
    primaryModel: "a",
    secondaryModel: "",
    secondaryModel2: "",
  })
  assert.ok(out.startsWith("## body"))
  assert.ok(out.includes("[src/a.ts#L2](src/a.ts#L2)"))
  assert.ok(!out.includes("### [src/a.ts](src/a.ts)"))
  assert.ok(!out.includes("**Line 2**"))
  assert.ok(out.includes("```typescript\nconst y = 2\n```"))
  assert.ok(!out.includes("> `const y = 2`"))
  assert.ok(out.includes("**warning**: x"))
  assert.ok(out.includes("[src/a.ts#L4](src/a.ts#L4)"))
  assert.ok(out.includes("[src/b.js#L1](src/b.js#L1)"))
  assert.ok(out.includes("```javascript\nmodule.exports = 1\n```"))
  assert.ok(out.indexOf("src/a.ts#L2") < out.indexOf("src/b.js#L1"))
})

function jsonReview() {
  return JSON.stringify({ summary: "ok", verdict: "comment", comments: [] })
}

function chatReply() {
  return { choices: [{ message: { content: jsonReview() } }] }
}

function anthropicReply() {
  return { content: [{ type: "text", text: jsonReview() }] }
}

function geminiReply() {
  return { candidates: [{ content: { parts: [{ text: jsonReview() }] } }] }
}

/**
 * @param {(input: RequestInfo, init?: RequestInit) => Promise<Response>} impl
 * @param {() => Promise<void>} fn
 */
async function withFetch(impl, fn) {
  const orig = globalThis.fetch
  globalThis.fetch = impl
  try {
    await fn()
  } finally {
    globalThis.fetch = orig
  }
}

/**
 * @param {string} spec
 * @param {import("../src/models.js").ProviderKeys} keys
 * @param {(url: string, init?: RequestInit) => Promise<Response>} impl
 */
async function runPrimary(spec, keys, impl) {
  /** @type {{ url: string, init?: RequestInit }[]} */
  const calls = []
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init })
    return impl(String(url), init)
  }, async () => {
    await runReview({
      diff: DIFF,
      workspace: process.cwd(),
      primaryModel: spec,
      secondaryModel: "",
      secondaryModel2: "",
      keys,
    })
  })
  return calls
}

test("runReview posts OpenAI chat-completions shape", async () => {
  const calls = await runPrimary("openai:gpt-5.4", { openai: "sk-oa" }, async () => Response.json(chatReply()))
  assert.equal(calls[0].url, OPENAI_URL)
  assert.equal(calls[0].init?.headers?.Authorization, "Bearer sk-oa")
  const body = JSON.parse(String(calls[0].init?.body))
  assert.equal(body.model, "gpt-5.4")
  assert.equal(body.messages[0].role, "system")
  assert.equal(body.messages[1].role, "user")
  assert.equal(body.max_completion_tokens, MAX_OUTPUT_TOKENS)
  assert.equal(body.max_tokens, undefined)
})

test("runReview posts Anthropic messages shape", async () => {
  const calls = await runPrimary("anthropic:claude-sonnet-4-6", { anthropic: "sk-ant" }, async () =>
    Response.json(anthropicReply())
  )
  assert.equal(calls[0].url, ANTHROPIC_URL)
  assert.equal(calls[0].init?.headers?.["x-api-key"], "sk-ant")
  assert.equal(calls[0].init?.headers?.["anthropic-version"], "2023-06-01")
  const body = JSON.parse(String(calls[0].init?.body))
  assert.equal(body.model, "claude-sonnet-4-6")
  assert.equal(typeof body.system, "string")
  assert.equal(body.messages[0].role, "user")
  assert.ok(body.max_tokens)
})

test("runReview posts Gemini generateContent to Google AI Studio", async () => {
  const calls = await runPrimary("gemini:gemini-2.5-pro", { gemini: "sk-gem" }, async () => Response.json(geminiReply()))
  assert.equal(calls[0].url, geminiUrl("gemini-2.5-pro"))
  assert.ok(calls[0].url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/"))
  assert.equal(calls[0].init?.headers?.["x-goog-api-key"], "sk-gem")
  const body = JSON.parse(String(calls[0].init?.body))
  assert.equal(body.contents[0].role, "user")
  assert.ok(body.systemInstruction.parts[0].text)
})

test("runReview posts OpenRouter chat-completions shape", async () => {
  const calls = await runPrimary("openrouter:deepseek/deepseek-v4-flash", { openrouter: "sk-or" }, async () =>
    Response.json(chatReply())
  )
  assert.equal(calls[0].url, OPENROUTER_URL)
  assert.equal(calls[0].init?.headers?.Authorization, "Bearer sk-or")
  const body = JSON.parse(String(calls[0].init?.body))
  assert.equal(body.model, "deepseek/deepseek-v4-flash")
  assert.equal(body.max_tokens, MAX_OUTPUT_TOKENS)
  assert.equal(body.max_completion_tokens, undefined)
})

test("runReview posts Z.AI chat-completions shape", async () => {
  const calls = await runPrimary("zai:glm-5.3", { zai: "sk-zai" }, async () => Response.json(chatReply()))
  assert.equal(calls[0].url, ZAI_URL)
  assert.equal(calls[0].init?.headers?.Authorization, "Bearer sk-zai")
  const body = JSON.parse(String(calls[0].init?.body))
  assert.equal(body.model, "glm-5.3")
  assert.equal(body.messages[0].role, "system")
  assert.equal(body.messages[1].role, "user")
  assert.equal(body.max_tokens, MAX_OUTPUT_TOKENS)
  assert.equal(body.max_completion_tokens, undefined)
})

test("runReview retries the same model on 503 then throws", async () => {
  const urls = []
  await withFetch(async (url) => {
    urls.push(String(url))
    return new Response("unavailable", { status: 503 })
  }, async () => {
    await assert.rejects(
      () =>
        runReview({
          diff: DIFF,
          workspace: process.cwd(),
          primaryModel: "openai:gpt-5.4",
          secondaryModel: "",
          secondaryModel2: "",
          keys: { openai: "sk" },
        }),
      /OpenAI 503 \(server error\)/
    )
  })
  assert.equal(urls.length, 2)
})

test("runReview times out a hung fetch instead of waiting forever", async () => {
  await withFetch(async (_url, init) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
        return
      }
      signal.addEventListener("abort", () => {
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
      })
    })
  }, async () => {
    await assert.rejects(
      () =>
        runReview({
          diff: DIFF,
          workspace: process.cwd(),
          primaryModel: "openai:gpt-5.4",
          secondaryModel: "",
          secondaryModel2: "",
          keys: { openai: "sk" },
          timeout: 1,
        }),
      /timed out after 1s/
    )
  })
})

test("runReview drops a failed secondary and still completes with the primary", async () => {
  const models = []
  await withFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    models.push(body.model || body.systemInstruction)
    if (body.model === "gpt-5.4") return new Response("unavailable", { status: 503 })
    return Response.json(chatReply())
  }, async () => {
    const result = await runReview({
      diff: DIFF,
      workspace: process.cwd(),
      primaryModel: "openrouter:alive/primary",
      secondaryModel: "openai:gpt-5.4",
      secondaryModel2: "",
      keys: { openrouter: "sk-or", openai: "sk-oa" },
    })
    assert.equal(result.primaryModel, "openrouter:alive/primary")
    assert.equal(result.secondaryModel, "")
  })
  assert.ok(models.includes("alive/primary"))
  assert.equal(models.filter((id) => id === "gpt-5.4").length, 2)
})

test("runReview does not retry a 429 on the same model", async () => {
  let n = 0
  await withFetch(async () => {
    n++
    return new Response("rate limited", { status: 429 })
  }, async () => {
    await assert.rejects(
      () =>
        runReview({
          diff: DIFF,
          workspace: process.cwd(),
          primaryModel: "openai:gpt-5.4",
          secondaryModel: "",
          secondaryModel2: "",
          keys: { openai: "sk" },
        }),
      /OpenAI 429 \(rate limited\)/
    )
  })
  assert.equal(n, 1)
})

test("runReview does not retry a 401", async () => {
  let n = 0
  await withFetch(async () => {
    n++
    return new Response("nope", { status: 401 })
  }, async () => {
    await assert.rejects(
      () =>
        runReview({
          diff: DIFF,
          workspace: process.cwd(),
          primaryModel: "openai:gpt-5.4",
          secondaryModel: "",
          secondaryModel2: "",
          keys: { openai: "sk" },
        }),
      /OpenAI 401 \(unauthorized\)/
    )
  })
  assert.equal(n, 1)
})

test("runReview retries a 200 with a non-JSON body", async () => {
  let n = 0
  await withFetch(async () => {
    n++
    return new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } })
  }, async () => {
    await assert.rejects(
      () =>
        runReview({
          diff: DIFF,
          workspace: process.cwd(),
          primaryModel: "openai:gpt-5.4",
          secondaryModel: "",
          secondaryModel2: "",
          keys: { openai: "sk" },
        }),
      /JSON|Unexpected/
    )
  })
  assert.equal(n, 2)
})

test("runReview retries an empty model reply without appending assistant text", async () => {
  const lengths = []
  await withFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    lengths.push(body.messages.length)
    return Response.json({ choices: [] })
  }, async () => {
    await assert.rejects(
      () =>
        runReview({
          diff: DIFF,
          workspace: process.cwd(),
          primaryModel: "openai:gpt-5.4",
          secondaryModel: "",
          secondaryModel2: "",
          keys: { openai: "sk" },
        }),
      /empty model reply/
    )
  })
  assert.deepEqual(lengths, [2, 2])
})

test("runReview retries an empty Gemini candidate list", async () => {
  let n = 0
  await withFetch(async () => {
    n++
    return Response.json({ candidates: [] })
  }, async () => {
    await assert.rejects(
      () =>
        runReview({
          diff: DIFF,
          workspace: process.cwd(),
          primaryModel: "gemini:gemini-2.5-pro",
          secondaryModel: "",
          secondaryModel2: "",
          keys: { gemini: "sk" },
        }),
      /empty model reply/
    )
  })
  assert.equal(n, 2)
})

test("runReview joins OpenAI content parts", async () => {
  const calls = await runPrimary("openai:gpt-5.4", { openai: "sk-oa" }, async () =>
    Response.json({
      choices: [{ message: { content: [{ type: "text", text: jsonReview() }] } }],
    })
  )
  assert.equal(calls.length, 1)
})

test("summarizeErrorBody uses the upstream hint and drops raw JSON", () => {
  const body = JSON.stringify({
    error: {
      message: "Provider returned error",
      code: 429,
      metadata: {
        raw: "google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly.",
        user_id: "user_secret",
      },
    },
    user_id: "user_secret",
  })
  assert.equal(summarizeErrorBody(body), "google/gemma-4-31b-it:free is temporarily rate-limited upstream.")
  assert.equal(
    formatHttpError("openrouter", 429, body),
    "OpenRouter 429 (rate limited): google/gemma-4-31b-it:free is temporarily rate-limited upstream."
  )
  assert.equal(formatHttpError("openai", 503, '{"error":{"message":"Provider returned error"}}'), "OpenAI 503 (server error)")
  assert.equal(formatHttpError("zai", 401, ""), "Z.AI 401 (unauthorized)")
  assert.doesNotMatch(formatHttpError("openrouter", 429, body), /user_secret/)
})

