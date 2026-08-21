import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configPath, formatConfig, loadConfig, maskSecret, saveConfig, unsetConfig } from "../src/store.js"

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), "kolpo-")), "config.json")
}

test("configPath uses KOLPO_CONFIG, then XDG, then ~/.config/kolpo", () => {
  assert.equal(configPath({ KOLPO_CONFIG: "/tmp/custom.json" }, "/home/me"), "/tmp/custom.json")
  assert.equal(configPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/me"), join("/xdg", "kolpo", "config.json"))
  assert.equal(configPath({}, "/home/me"), join("/home/me", ".config", "kolpo", "config.json"))
})

test("saveConfig merges, loadConfig reads, unsetConfig removes a key", () => {
  const file = tempFile()
  saveConfig({ anthropicApiKey: "sk-secret", model: "anthropic:claude-sonnet-4-6" }, file)
  saveConfig({ model1: "" }, file)
  const loaded = loadConfig(file)
  assert.deepEqual(loaded, { anthropicApiKey: "sk-secret", model: "anthropic:claude-sonnet-4-6", model1: "" })
  const after = unsetConfig("anthropicApiKey", file)
  assert.equal(after.anthropicApiKey, undefined)
  assert.equal(after.model, "anthropic:claude-sonnet-4-6")
  const raw = JSON.parse(readFileSync(file, "utf8"))
  assert.equal("anthropicApiKey" in raw, false)
})

test("loadConfig returns empty object when missing and rejects invalid json", () => {
  const file = tempFile()
  assert.deepEqual(loadConfig(file), {})
  writeFileSync(file, "{not json")
  assert.throws(() => loadConfig(file), /Invalid config/)
})

test("maskSecret and formatConfig hide provider keys", () => {
  assert.equal(maskSecret("abcd"), "****")
  assert.equal(maskSecret("sk-or-v1-abcdef"), "****cdef")
  const text = formatConfig(
    {
      anthropicApiKey: "sk-secret-key",
      openaiApiKey: "sk-openai-key",
      model: "anthropic:claude-sonnet-4-6",
      model1: "",
    },
    "/tmp/c.json"
  )
  assert.ok(text.includes("****-key"))
  assert.ok(!text.includes("sk-secret-key"))
  assert.ok(!text.includes("sk-openai-key"))
  assert.ok(text.includes("(disabled)"))
  assert.ok(text.includes("anthropic:claude-sonnet-4-6"))
  assert.ok(text.includes("anthropic-api-key:"))
  assert.ok(text.includes("openai-api-key:"))
  assert.ok(text.includes("gemini-api-key:"))
  assert.ok(text.includes("openrouter-api-key:"))
  assert.ok(text.includes("zai-api-key:"))
})

test("formatConfig labels an unset primary model as not set", () => {
  const text = formatConfig({}, "/tmp/c.json")
  assert.match(text, /^  model: \(not set\)$/m)
  assert.match(text, /^  model-1: \(default\)$/m)
  assert.match(text, /^  base: \(default\)$/m)
  assert.doesNotMatch(text, /^  model: \(default\)$/m)
})
