export const PROVIDERS = ["anthropic", "openai", "gemini", "openrouter"]

/**
 * @typedef {"anthropic" | "openai" | "gemini" | "openrouter"} Provider
 */

/**
 * @typedef {object} ParsedModel
 * @property {Provider} provider
 * @property {string} id
 */

/**
 * @typedef {object} ProviderKeyMeta
 * @property {import("./store.js").ConfigField} config
 * @property {string} flag
 * @property {string} env
 * @property {string} label
 */

/** @type {Record<Provider, ProviderKeyMeta>} */
export const PROVIDER_KEYS = {
  anthropic: {
    config: "anthropicApiKey",
    flag: "anthropic-api-key",
    env: "ANTHROPIC_API_KEY",
    label: "Anthropic",
  },
  openai: {
    config: "openaiApiKey",
    flag: "openai-api-key",
    env: "OPENAI_API_KEY",
    label: "OpenAI",
  },
  gemini: {
    config: "geminiApiKey",
    flag: "gemini-api-key",
    env: "GEMINI_API_KEY",
    label: "Gemini",
  },
  openrouter: {
    config: "openrouterApiKey",
    flag: "openrouter-api-key",
    env: "OPENROUTER_API_KEY",
    label: "OpenRouter",
  },
}

/**
 * @typedef {object} ProviderKeys
 * @property {string} [anthropic]
 * @property {string} [openai]
 * @property {string} [gemini]
 * @property {string} [openrouter]
 */

/**
 * @param {string} spec
 * @returns {ParsedModel}
 */
export function parseModel(spec) {
  const value = String(spec ?? "").trim()
  if (!value) throw new Error("model spec is empty")
  if (value === "dynamic:free") {
    throw new Error("dynamic:free is not supported. Use provider:model, e.g. anthropic:claude-sonnet-4-6")
  }
  const colon = value.indexOf(":")
  if (colon <= 0) {
    throw new Error(`model spec "${value}" must be provider:id (anthropic, openai, gemini, or openrouter)`)
  }
  const provider = value.slice(0, colon).toLowerCase()
  const id = value.slice(colon + 1).trim()
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`unknown provider "${provider}". Use anthropic, openai, gemini, or openrouter`)
  }
  if (!id) throw new Error(`model spec "${value}" is missing a model id`)
  return { provider: /** @type {Provider} */ (provider), id }
}

/**
 * @param {...string} specs
 * @returns {Provider[]}
 */
export function usedProviders(...specs) {
  /** @type {Provider[]} */
  const found = []
  const seen = new Set()
  for (const spec of specs) {
    if (!String(spec || "").trim()) continue
    const { provider } = parseModel(spec)
    if (seen.has(provider)) continue
    seen.add(provider)
    found.push(provider)
  }
  return found
}

/**
 * @param {string[]} specs
 * @param {Partial<Record<import("./store.js").ConfigField, string>>} flags
 * @param {NodeJS.ProcessEnv} [env]
 * @param {import("./store.js").SavedConfig} [saved]
 * @returns {ProviderKeys}
 */
export function resolveProviderKeys(specs, flags, env = process.env, saved = {}) {
  /** @type {ProviderKeys} */
  const keys = {}
  for (const provider of usedProviders(...specs)) {
    const meta = PROVIDER_KEYS[provider]
    const flag = flags[meta.config]
    const key = (flag !== undefined ? flag : env[meta.env] || saved[meta.config] || "").trim()
    if (!key) {
      throw new Error(
        `${meta.label} API key missing. Pass --${meta.flag}, set ${meta.env}, or run kolpo config set ${meta.flag} <key>.`
      )
    }
    keys[provider] = key
  }
  return keys
}
