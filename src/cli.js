import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_MODEL_1, DEFAULT_MODEL_2 } from "./config.js"
import { currentBranch, defaultBase, gitDiff } from "./git.js"
import { parseModel, resolveProviderKeys } from "./models.js"
import { maybePostToGithub } from "./post.js"
import { formatCliOutput, runReview } from "./review.js"
import { CONFIG_KEY_MAP, configPath, formatConfig, loadConfig, parseConfigKey, saveConfig, unsetConfig } from "./store.js"

export const HELP = `Usage: kolpo [base] [options]
       kolpo help
       kolpo config
       kolpo config show
       kolpo config set <key> <value>
       kolpo config unset <key>
       kolpo config path

Review the current branch against a base ref. Writes REVIEW_<key>.md.
If stdin is a TTY, asks whether to post the review to the open GitHub PR.

Arguments:
  base                         Git branch or commit to diff against (same as --base).
                               Example: kolpo main  →  review vs main.
                               If omitted: saved base, else origin/HEAD, then main, then master.

Options:
  --base <ref>                 Base branch or commit
  --model <provider:id>        Primary model (required: flag or saved config)
  --model-1 <provider:id>      First secondary model, or empty to disable (default: saved, else disabled)
  --model-2 <provider:id>      Second secondary model, or empty to disable (default: saved, else disabled)
  --anthropic-api-key <key>    Anthropic API key (overrides ANTHROPIC_API_KEY and saved config)
  --openai-api-key <key>       OpenAI API key (overrides OPENAI_API_KEY and saved config)
  --gemini-api-key <key>       Google AI Studio API key (overrides GEMINI_API_KEY and saved config)
  --openrouter-api-key <key>   OpenRouter API key (overrides OPENROUTER_API_KEY and saved config)
  --zai-api-key <key>          Z.AI API key (overrides ZAI_API_KEY and saved config)
  --extra-instructions <text>  Project-specific guidance appended to the system prompt
  --save                       Persist passed flags to the config file
  -h, --help                   Show this help

Providers: anthropic, openai, gemini, openrouter, zai. Specs are provider:id.
A provider's key is required only when a slot uses that provider.

Config keys: anthropic-api-key, openai-api-key, gemini-api-key, openrouter-api-key, zai-api-key,
             model, model-1, model-2, extra-instructions, base
Config file: ~/.config/kolpo/config.json (override with KOLPO_CONFIG)
`

/**
 * @typedef {object} ReviewCliOptions
 * @property {"review"} command
 * @property {string} [base]
 * @property {string} [model]
 * @property {string} [model1]
 * @property {boolean} model1Specified
 * @property {string} [model2]
 * @property {boolean} model2Specified
 * @property {string} [anthropicApiKey]
 * @property {string} [openaiApiKey]
 * @property {string} [geminiApiKey]
 * @property {string} [openrouterApiKey]
 * @property {string} [zaiApiKey]
 * @property {string} [extraInstructions]
 * @property {boolean} extraSpecified
 * @property {boolean} save
 * @property {boolean} help
 */

/**
 * @typedef {object} ConfigCliOptions
 * @property {"config"} command
 * @property {"show" | "set" | "unset" | "path"} action
 * @property {import("./store.js").ConfigField} [key]
 * @property {string} [value]
 * @property {boolean} help
 */

/**
 * @typedef {ReviewCliOptions | ConfigCliOptions} CliOptions
 */

/**
 * @typedef {object} ResolvedReviewOptions
 * @property {string} [base]
 * @property {string} model
 * @property {string} model1
 * @property {string} model2
 * @property {import("./models.js").ProviderKeys} keys
 * @property {string} [extraInstructions]
 */

/**
 * @param {string} arg
 * @param {string} flag
 * @returns {boolean}
 */
function matchesFlag(arg, flag) {
  return arg === flag || arg.startsWith(`${flag}=`)
}

/**
 * @param {string[]} args
 * @param {number} i
 * @param {string} flag
 * @returns {[string, number]}
 */
function takeValue(args, i, flag) {
  const cur = args[i]
  const prefix = `${flag}=`
  if (cur.startsWith(prefix)) return [cur.slice(prefix.length), i]
  if (i + 1 >= args.length) throw new Error(`${flag} requires a value`)
  const value = args[i + 1]
  if (value.startsWith("-") && value !== "--") throw new Error(`${flag} requires a value`)
  return [value, i + 1]
}

/**
 * @param {string[]} argv
 * @returns {ConfigCliOptions}
 */
function parseConfigArgs(argv) {
  /** @type {ConfigCliOptions} */
  const opts = { command: "config", action: "show", help: false }
  if (argv[0] === "--help" || argv[0] === "-h") {
    opts.help = true
    return opts
  }
  if (!argv.length || argv[0] === "show") return opts
  if (argv[0] === "path") {
    opts.action = "path"
    return opts
  }
  if (argv[0] === "set") {
    if (!argv[1]) throw new Error("Usage: kolpo config set <key> <value>")
    if (argv.length < 3) throw new Error(`Usage: kolpo config set ${argv[1]} <value>`)
    opts.action = "set"
    opts.key = CONFIG_KEY_MAP[parseConfigKey(argv[1])]
    opts.value = argv.slice(2).join(" ")
    return opts
  }
  if (argv[0] === "unset") {
    if (!argv[1]) throw new Error("Usage: kolpo config unset <key>")
    opts.action = "unset"
    opts.key = CONFIG_KEY_MAP[parseConfigKey(argv[1])]
    return opts
  }
  throw new Error(`Unknown config command "${argv[0]}". Use show, set, unset, or path.`)
}

/**
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseArgs(argv) {
  if (argv[0] === "help") {
    return {
      command: "review",
      model1Specified: false,
      model2Specified: false,
      extraSpecified: false,
      save: false,
      help: true,
    }
  }
  if (argv[0] === "config") return parseConfigArgs(argv.slice(1))

  /** @type {ReviewCliOptions} */
  const opts = {
    command: "review",
    model1Specified: false,
    model2Specified: false,
    extraSpecified: false,
    save: false,
    help: false,
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      opts.help = true
      continue
    }
    if (arg === "--save") {
      opts.save = true
      continue
    }
    if (arg === "--base" || arg.startsWith("--base=")) {
      const [value, next] = takeValue(argv, i, "--base")
      opts.base = value
      i = next
      continue
    }
    if (matchesFlag(arg, "--model-2")) {
      const [value, next] = takeValue(argv, i, "--model-2")
      opts.model2 = value
      opts.model2Specified = true
      i = next
      continue
    }
    if (matchesFlag(arg, "--model-1")) {
      const [value, next] = takeValue(argv, i, "--model-1")
      opts.model1 = value
      opts.model1Specified = true
      i = next
      continue
    }
    if (matchesFlag(arg, "--model")) {
      const [value, next] = takeValue(argv, i, "--model")
      opts.model = value
      i = next
      continue
    }
    if (arg === "--anthropic-api-key" || arg.startsWith("--anthropic-api-key=")) {
      const [value, next] = takeValue(argv, i, "--anthropic-api-key")
      opts.anthropicApiKey = value
      i = next
      continue
    }
    if (arg === "--openai-api-key" || arg.startsWith("--openai-api-key=")) {
      const [value, next] = takeValue(argv, i, "--openai-api-key")
      opts.openaiApiKey = value
      i = next
      continue
    }
    if (arg === "--gemini-api-key" || arg.startsWith("--gemini-api-key=")) {
      const [value, next] = takeValue(argv, i, "--gemini-api-key")
      opts.geminiApiKey = value
      i = next
      continue
    }
    if (arg === "--openrouter-api-key" || arg.startsWith("--openrouter-api-key=")) {
      const [value, next] = takeValue(argv, i, "--openrouter-api-key")
      opts.openrouterApiKey = value
      i = next
      continue
    }
    if (arg === "--zai-api-key" || arg.startsWith("--zai-api-key=")) {
      const [value, next] = takeValue(argv, i, "--zai-api-key")
      opts.zaiApiKey = value
      i = next
      continue
    }
    if (arg === "--extra-instructions" || arg.startsWith("--extra-instructions=")) {
      const [value, next] = takeValue(argv, i, "--extra-instructions")
      opts.extraInstructions = value
      opts.extraSpecified = true
      i = next
      continue
    }
    if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`)
    positional.push(arg)
  }
  if (opts.base == null && positional[0]) opts.base = positional[0]
  if (positional.length > 1) throw new Error(`Unexpected extra arguments: ${positional.slice(1).join(" ")}`)
  return opts
}

/**
 * @param {ReviewCliOptions} opts
 * @param {import("./store.js").SavedConfig} saved
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ResolvedReviewOptions}
 */
export function resolveReviewOptions(opts, saved, env = process.env) {
  const model = (opts.model ?? saved.model ?? "").trim()
  if (!model) {
    throw new Error("Primary model missing. Pass --model provider:id or run kolpo config set model <spec>.")
  }
  const model1 = (
    opts.model1Specified ? (opts.model1 ?? "") : saved.model1 !== undefined ? saved.model1 : DEFAULT_MODEL_1
  ).trim()
  const model2 = (
    opts.model2Specified ? (opts.model2 ?? "") : saved.model2 !== undefined ? saved.model2 : DEFAULT_MODEL_2
  ).trim()
  parseModel(model)
  if (model1) parseModel(model1)
  if (model2) parseModel(model2)
  return {
    base: opts.base ?? saved.base,
    model,
    model1,
    model2,
    keys: resolveProviderKeys(
      [model, model1, model2],
      {
        anthropicApiKey: opts.anthropicApiKey,
        openaiApiKey: opts.openaiApiKey,
        geminiApiKey: opts.geminiApiKey,
        openrouterApiKey: opts.openrouterApiKey,
        zaiApiKey: opts.zaiApiKey,
      },
      env,
      saved
    ),
    extraInstructions: opts.extraSpecified ? opts.extraInstructions : saved.extraInstructions,
  }
}

/**
 * @param {string} [key]
 * @returns {string}
 */
export function reviewMarkdownName(key = randomBytes(4).toString("hex")) {
  return `REVIEW_${key}.md`
}

/**
 * @param {string} cwd
 * @param {string} content
 * @returns {string}
 */
export function writeReviewMarkdown(cwd, content) {
  const body = content.endsWith("\n") ? content : `${content}\n`
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = reviewMarkdownName()
    try {
      writeFileSync(join(cwd, name), body, { encoding: "utf8", flag: "wx" })
      return name
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err
    }
  }
  throw new Error("Could not create a unique REVIEW_*.md file")
}

/**
 * @param {ReviewCliOptions} opts
 * @param {string} file
 */
function persistPassedFlags(opts, file) {
  /** @type {import("./store.js").SavedConfig} */
  const partial = {}
  if (opts.anthropicApiKey !== undefined) partial.anthropicApiKey = opts.anthropicApiKey
  if (opts.openaiApiKey !== undefined) partial.openaiApiKey = opts.openaiApiKey
  if (opts.geminiApiKey !== undefined) partial.geminiApiKey = opts.geminiApiKey
  if (opts.openrouterApiKey !== undefined) partial.openrouterApiKey = opts.openrouterApiKey
  if (opts.zaiApiKey !== undefined) partial.zaiApiKey = opts.zaiApiKey
  if (opts.model !== undefined) partial.model = opts.model
  if (opts.model1Specified) partial.model1 = opts.model1 ?? ""
  if (opts.model2Specified) partial.model2 = opts.model2 ?? ""
  if (opts.extraSpecified) partial.extraInstructions = opts.extraInstructions
  if (opts.base !== undefined) partial.base = opts.base
  if (!Object.keys(partial).length) {
    console.error(
      "Nothing to save. Pass --model, --model-1, --model-2, a provider API key, --extra-instructions, or --base with --save."
    )
    return
  }
  const next = saveConfig(partial, file)
  console.log(formatConfig(next, file))
}

/**
 * @param {ConfigCliOptions} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function runConfig(opts, env = process.env) {
  const file = configPath(env)
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  if (opts.action === "path") {
    console.log(file)
    return 0
  }
  if (opts.action === "show") {
    console.log(formatConfig(loadConfig(file), file))
    return 0
  }
  if (opts.action === "set" && opts.key !== undefined) {
    const next = saveConfig({ [opts.key]: opts.value ?? "" }, file)
    console.log(formatConfig(next, file))
    return 0
  }
  if (opts.action === "unset" && opts.key !== undefined) {
    const next = unsetConfig(opts.key, file)
    console.log(formatConfig(next, file))
    return 0
  }
  return 1
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>}
 */
export async function runCli(argv = process.argv.slice(2)) {
  /** @type {CliOptions} */
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    console.error(HELP)
    return 1
  }
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  if (opts.command === "config") return runConfig(opts)

  const file = configPath()
  let saved
  try {
    saved = loadConfig(file)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    return 1
  }

  let resolved
  try {
    resolved = resolveReviewOptions(opts, saved, process.env)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    return 1
  }

  if (opts.save) persistPassedFlags(opts, file)

  const cwd = process.cwd()
  const base = resolved.base || defaultBase(cwd)
  const branch = currentBranch(cwd)
  const diff = gitDiff(cwd, base)
  if (!diff.trim()) {
    console.log(`No changes vs ${base}.`)
    return 0
  }

  console.log(
    `Chosen models: model=${resolved.model} model-1=${resolved.model1 || "(none)"} model-2=${resolved.model2 || "(none)"}`
  )

  const result = await runReview({
    diff,
    workspace: cwd,
    title: `Branch review: ${branch} vs ${base}`,
    extraInstructions: resolved.extraInstructions,
    primaryModel: resolved.model,
    secondaryModel: resolved.model1,
    secondaryModel2: resolved.model2,
    keys: resolved.keys,
  })

  const modelsNote = [result.primaryModel, result.secondaryModel, result.secondaryModel2].filter(Boolean).join(", ")
  const markdown = [
    `<!-- ${branch} vs ${base}; ${modelsNote} -->`,
    formatCliOutput(result),
    ``,
  ].join("\n")
  const written = writeReviewMarkdown(cwd, markdown)
  console.log(`Wrote ${written}`)
  try {
    await maybePostToGithub({ cwd, branch, result })
  } catch (err) {
    console.error(`Could not post review to GitHub: ${err instanceof Error ? err.message : err}`)
  }
  return result.review.verdict === "request_changes" ? 1 : 0
}

const isDirect = Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isDirect) {
  runCli().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    }
  )
}
