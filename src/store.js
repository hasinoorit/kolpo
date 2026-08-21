import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const CONFIG_KEY_MAP = {
  "anthropic-api-key": "anthropicApiKey",
  "openai-api-key": "openaiApiKey",
  "gemini-api-key": "geminiApiKey",
  "openrouter-api-key": "openrouterApiKey",
  model: "model",
  "model-1": "model1",
  "model-2": "model2",
  "extra-instructions": "extraInstructions",
  base: "base",
}

const CONFIG_FIELDS = [
  "anthropicApiKey",
  "openaiApiKey",
  "geminiApiKey",
  "openrouterApiKey",
  "model",
  "model1",
  "model2",
  "extraInstructions",
  "base",
]

/**
 * @typedef {"anthropic-api-key" | "openai-api-key" | "gemini-api-key" | "openrouter-api-key" | "model" | "model-1" | "model-2" | "extra-instructions" | "base"} ConfigFlag
 */

/**
 * @typedef {"anthropicApiKey" | "openaiApiKey" | "geminiApiKey" | "openrouterApiKey" | "model" | "model1" | "model2" | "extraInstructions" | "base"} ConfigField
 */

/**
 * @typedef {object} SavedConfig
 * @property {string} [anthropicApiKey]
 * @property {string} [openaiApiKey]
 * @property {string} [geminiApiKey]
 * @property {string} [openrouterApiKey]
 * @property {string} [model]
 * @property {string} [model1]
 * @property {string} [model2]
 * @property {string} [extraInstructions]
 * @property {string} [base]
 */

/**
 * @param {unknown} raw
 * @returns {SavedConfig}
 */
export function parseSavedConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be an object")
  /** @type {SavedConfig} */
  const out = {}
  for (const key of CONFIG_FIELDS) {
    if (!(key in raw)) continue
    const value = /** @type {Record<string, unknown>} */ (raw)[key]
    if (typeof value !== "string") throw new Error(`${key} must be a string`)
    out[key] = value
  }
  return out
}

/**
 * @param {SavedConfig} value
 * @returns {SavedConfig}
 */
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function configPath(env = process.env, home = homedir()) {
  if (env.KOLPO_CONFIG?.trim()) return env.KOLPO_CONFIG.trim()
  const base = env.XDG_CONFIG_HOME?.trim() || join(home, ".config")
  return join(base, "kolpo", "config.json")
}

/**
 * @param {string} [file]
 * @returns {SavedConfig}
 */
export function loadConfig(file = configPath()) {
  if (!existsSync(file)) return {}
  try {
    return compact(parseSavedConfig(JSON.parse(readFileSync(file, "utf8"))))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid config at ${file}: ${message}`)
  }
}

/**
 * @param {SavedConfig} partial
 * @param {string} [file]
 * @returns {SavedConfig}
 */
export function saveConfig(partial, file = configPath()) {
  const next = compact(parseSavedConfig({ ...loadConfig(file), ...partial }))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  chmodSync(file, 0o600)
  return next
}

/**
 * @param {ConfigField} field
 * @param {string} [file]
 * @returns {SavedConfig}
 */
export function unsetConfig(field, file = configPath()) {
  const current = loadConfig(file)
  delete current[field]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(current, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  chmodSync(file, 0o600)
  return current
}

/**
 * @param {string} raw
 * @returns {ConfigFlag}
 */
export function parseConfigKey(raw) {
  if (Object.hasOwn(CONFIG_KEY_MAP, raw)) return /** @type {ConfigFlag} */ (raw)
  throw new Error(
    `Unknown config key "${raw}". Use: anthropic-api-key, openai-api-key, gemini-api-key, openrouter-api-key, model, model-1, model-2, extra-instructions, base`
  )
}

/**
 * @param {string} value
 * @returns {string}
 */
export function maskSecret(value) {
  if (value.length <= 4) return "****"
  return `****${value.slice(-4)}`
}

/**
 * @param {string} [value]
 * @returns {string}
 */
function slotLabel(value) {
  if (value === undefined) return "(default)"
  if (value === "") return "(disabled)"
  return value
}

/**
 * @param {string} [value]
 * @returns {string}
 */
function keyLabel(value) {
  return value ? maskSecret(value) : "(not set)"
}

/**
 * @param {SavedConfig} saved
 * @param {string} file
 * @returns {string}
 */
export function formatConfig(saved, file) {
  const lines = [`Config: ${file}`]
  lines.push(`  anthropic-api-key: ${keyLabel(saved.anthropicApiKey)}`)
  lines.push(`  openai-api-key: ${keyLabel(saved.openaiApiKey)}`)
  lines.push(`  gemini-api-key: ${keyLabel(saved.geminiApiKey)}`)
  lines.push(`  openrouter-api-key: ${keyLabel(saved.openrouterApiKey)}`)
  lines.push(`  model: ${saved.model || "(not set)"}`)
  lines.push(`  model-1: ${slotLabel(saved.model1)}`)
  lines.push(`  model-2: ${slotLabel(saved.model2)}`)
  lines.push(`  extra-instructions: ${saved.extraInstructions ?? "(not set)"}`)
  lines.push(`  base: ${saved.base ?? "(default)"}`)
  return lines.join("\n")
}
