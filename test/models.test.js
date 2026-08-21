import { test } from "node:test"
import assert from "node:assert/strict"
import { parseModel, resolveProviderKeys, usedProviders } from "../src/models.js"

test("parseModel splits provider:id on the first colon", () => {
  assert.deepEqual(parseModel("anthropic:claude-sonnet-4-6"), { provider: "anthropic", id: "claude-sonnet-4-6" })
  assert.deepEqual(parseModel("openai:gpt-5.4"), { provider: "openai", id: "gpt-5.4" })
  assert.deepEqual(parseModel("gemini:gemini-2.5-pro"), { provider: "gemini", id: "gemini-2.5-pro" })
  assert.deepEqual(parseModel("openrouter:openai/gpt-oss-120b:free"), {
    provider: "openrouter",
    id: "openai/gpt-oss-120b:free",
  })
  assert.deepEqual(parseModel("OpenAI:gpt-5.4"), { provider: "openai", id: "gpt-5.4" })
  assert.deepEqual(parseModel("Gemini:gemini-2.5-pro"), { provider: "gemini", id: "gemini-2.5-pro" })
})

test("parseModel rejects empty, dynamic:free, and unknown providers", () => {
  assert.throws(() => parseModel(""), /empty/)
  assert.throws(() => parseModel("dynamic:free"), /not supported/)
  assert.throws(() => parseModel("claude-sonnet-4-6"), /must be provider:id/)
  assert.throws(() => parseModel("foo:bar"), /unknown provider/)
  assert.throws(() => parseModel("anthropic:"), /missing a model id/)
})

test("usedProviders skips empty slots and dedupes", () => {
  assert.deepEqual(usedProviders("anthropic:a", "", "openai:b", "anthropic:c"), ["anthropic", "openai"])
})

test("resolveProviderKeys requires keys only for used providers", () => {
  assert.deepEqual(
    resolveProviderKeys(["anthropic:claude-sonnet-4-6"], { anthropicApiKey: "sk-ant" }, {}, {}),
    { anthropic: "sk-ant" }
  )
  assert.equal(
    resolveProviderKeys(["openai:gpt-5.4"], {}, { OPENAI_API_KEY: "sk-env" }, {}).openai,
    "sk-env"
  )
  assert.equal(
    resolveProviderKeys(["gemini:gemini-2.5-pro"], {}, {}, { geminiApiKey: "sk-saved" }).gemini,
    "sk-saved"
  )
  assert.throws(
    () => resolveProviderKeys(["openrouter:deepseek/x"], {}, {}, {}),
    /OpenRouter API key missing/
  )
  assert.doesNotThrow(() => resolveProviderKeys(["anthropic:a", ""], { anthropicApiKey: "k" }, {}, {}))
})

test("resolveProviderKeys does not fall through a specified empty flag", () => {
  assert.throws(
    () =>
      resolveProviderKeys(
        ["openai:gpt-5.4"],
        { openaiApiKey: "" },
        { OPENAI_API_KEY: "sk-env" },
        { openaiApiKey: "sk-saved" }
      ),
    /OpenAI API key missing/
  )
  assert.equal(
    resolveProviderKeys(["openai:gpt-5.4"], {}, { OPENAI_API_KEY: "sk-env" }, { openaiApiKey: "sk-saved" }).openai,
    "sk-env"
  )
})
