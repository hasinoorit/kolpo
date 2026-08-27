import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs, resolveReviewOptions, runCli, reviewMarkdownName, writeReviewMarkdown, HELP } from "../src/cli.js"
import { DEFAULT_MODEL_1, DEFAULT_MODEL_2, DEFAULT_TIMEOUT } from "../src/config.js"
import { loadConfig } from "../src/store.js"
import { execFileSync } from "node:child_process"

const reviewDefaults = {
  command: "review",
  model1Specified: false,
  model2Specified: false,
  extraSpecified: false,
  save: false,
  help: false,
}

test("parseArgs defaults to review without pinning models", () => {
  assert.deepEqual(parseArgs([]), reviewDefaults)
})

test("parseArgs accepts positional base and flags", () => {
  const opts = parseArgs([
    "main",
    "--model",
    "anthropic:claude-sonnet-4-6",
    "--model-1",
    "openai:gpt-5.4",
    "--model-2",
    "gemini:gemini-2.5-pro",
    "--anthropic-api-key",
    "sk-ant",
    "--openai-api-key",
    "sk-oa",
    "--gemini-api-key",
    "sk-gem",
    "--zai-api-key",
    "sk-zai",
    "--timeout",
    "180",
    "--extra-instructions",
    "watch rounding",
    "--save",
  ])
  assert.equal(opts.command, "review")
  if (opts.command !== "review") return
  assert.equal(opts.base, "main")
  assert.equal(opts.model, "anthropic:claude-sonnet-4-6")
  assert.equal(opts.model1, "openai:gpt-5.4")
  assert.equal(opts.model1Specified, true)
  assert.equal(opts.model2, "gemini:gemini-2.5-pro")
  assert.equal(opts.model2Specified, true)
  assert.equal(opts.anthropicApiKey, "sk-ant")
  assert.equal(opts.openaiApiKey, "sk-oa")
  assert.equal(opts.geminiApiKey, "sk-gem")
  assert.equal(opts.zaiApiKey, "sk-zai")
  assert.equal(opts.timeout, "180")
  assert.equal(opts.extraInstructions, "watch rounding")
  assert.equal(opts.extraSpecified, true)
  assert.equal(opts.save, true)
})

test("parseArgs --base overrides positional and equals form works", () => {
  const opts = parseArgs(["ignored", "--base=origin/dev", "--model=openai:gpt-5.4"])
  assert.equal(opts.command, "review")
  if (opts.command !== "review") return
  assert.equal(opts.base, "origin/dev")
  assert.equal(opts.model, "openai:gpt-5.4")
})

test("parseArgs empty --model-1 and --model-2 disable those slots", () => {
  const opts = parseArgs(["--model-1=", "--model-2="])
  assert.equal(opts.command, "review")
  if (opts.command !== "review") return
  assert.equal(opts.model1, "")
  assert.equal(opts.model1Specified, true)
  assert.equal(opts.model2, "")
  assert.equal(opts.model2Specified, true)
})

test("parseArgs does not treat the next flag as a value", () => {
  assert.throws(() => parseArgs(["--model-1", "--save"]), /--model-1 requires a value/)
  assert.throws(() => parseArgs(["--model", "--openai-api-key", "sk"]), /--model requires a value/)
  assert.throws(() => parseArgs(["--openai-api-key"]), /--openai-api-key requires a value/)
})

test("parseArgs help and unknown flag", () => {
  assert.equal(parseArgs(["--help"]).help, true)
  assert.equal(parseArgs(["-h"]).help, true)
  assert.equal(parseArgs(["help"]).help, true)
  assert.equal(parseArgs(["help"]).command, "review")
  assert.throws(() => parseArgs(["--nope"]), /Unknown flag/)
  assert.throws(() => parseArgs(["main", "extra"]), /Unexpected extra arguments/)
})

test("HELP documents positional base and --help", () => {
  assert.match(HELP, /kolpo main/)
  assert.match(HELP, /--help/)
  assert.match(HELP, /kolpo config show/)
  assert.match(HELP, /zai-api-key/)
  assert.match(HELP, /--timeout/)
  assert.match(HELP, /Providers:.*zai/)
})

test("runCli --help prints usage and exits 0", async () => {
  const logs = []
  const orig = console.log
  console.log = (...args) => logs.push(args.join(" "))
  try {
    assert.equal(await runCli(["--help"]), 0)
    assert.equal(await runCli(["-h"]), 0)
    assert.equal(await runCli(["help"]), 0)
  } finally {
    console.log = orig
  }
  const text = logs.join("\n")
  assert.match(text, /Usage: kolpo/)
  assert.match(text, /kolpo main/)
})

test("parseArgs config subcommands", () => {
  assert.deepEqual(parseArgs(["config"]), { command: "config", action: "show", help: false })
  assert.deepEqual(parseArgs(["config", "path"]), { command: "config", action: "path", help: false })
  assert.deepEqual(parseArgs(["config", "set", "anthropic-api-key", "sk-ant"]), {
    command: "config",
    action: "set",
    key: "anthropicApiKey",
    value: "sk-ant",
    help: false,
  })
  assert.deepEqual(parseArgs(["config", "set", "extra-instructions", "watch", "rounding"]), {
    command: "config",
    action: "set",
    key: "extraInstructions",
    value: "watch rounding",
    help: false,
  })
  assert.deepEqual(parseArgs(["config", "unset", "model"]), {
    command: "config",
    action: "unset",
    key: "model",
    help: false,
  })
  assert.deepEqual(parseArgs(["config", "set", "model-2", "openai:gpt-5.4"]), {
    command: "config",
    action: "set",
    key: "model2",
    value: "openai:gpt-5.4",
    help: false,
  })
  assert.deepEqual(parseArgs(["config", "set", "zai-api-key", "sk-zai"]), {
    command: "config",
    action: "set",
    key: "zaiApiKey",
    value: "sk-zai",
    help: false,
  })
  assert.deepEqual(parseArgs(["config", "set", "timeout", "180"]), {
    command: "config",
    action: "set",
    key: "timeout",
    value: "180",
    help: false,
  })
  assert.throws(() => parseArgs(["config", "set", "api-key", "x"]), /Unknown config key/)
  assert.throws(() => parseArgs(["config", "set", "nope", "x"]), /Unknown config key/)
  assert.throws(() => parseArgs(["config", "set", "model"]), /Usage: kolpo config set model/)
})

test("resolveReviewOptions uses flag, then saved, then empty secondaries", () => {
  const resolved = resolveReviewOptions(
    reviewDefaults,
    { anthropicApiKey: "sk-saved", model: "anthropic:saved" },
    {}
  )
  assert.deepEqual(resolved.keys, { anthropic: "sk-saved" })
  assert.equal(resolved.model, "anthropic:saved")
  assert.equal(resolved.model1, DEFAULT_MODEL_1)
  assert.equal(resolved.model2, DEFAULT_MODEL_2)

  const flagged = resolveReviewOptions(
    {
      ...reviewDefaults,
      model: "openai:flag",
      openaiApiKey: "sk-flag",
      model1Specified: true,
      model1: "",
      model2Specified: true,
      model2: "",
    },
    { model: "anthropic:saved", model1: "saved/one", model2: "saved/two", anthropicApiKey: "sk-saved" },
    {}
  )
  assert.equal(flagged.model, "openai:flag")
  assert.equal(flagged.model1, "")
  assert.equal(flagged.model2, "")
  assert.deepEqual(flagged.keys, { openai: "sk-flag" })

  assert.throws(() => resolveReviewOptions({ ...reviewDefaults }, {}, {}), /Primary model missing/)
})

test("resolveReviewOptions keeps a saved empty model-1 as disabled", () => {
  const resolved = resolveReviewOptions(
    reviewDefaults,
    { anthropicApiKey: "sk", model: "anthropic:a", model1: "", model2: "" },
    {}
  )
  assert.equal(resolved.model1, "")
  assert.equal(resolved.model2, "")
})

test("resolveReviewOptions trims whitespace-only secondaries to disabled", () => {
  const flagged = resolveReviewOptions(
    {
      ...reviewDefaults,
      model: "openai:gpt-5.4",
      openaiApiKey: "sk",
      model1Specified: true,
      model1: "  ",
      model2Specified: true,
      model2: "\t",
    },
    {},
    {}
  )
  assert.equal(flagged.model1, "")
  assert.equal(flagged.model2, "")

  const saved = resolveReviewOptions(
    { ...reviewDefaults, model: "openai:gpt-5.4", openaiApiKey: "sk" },
    { model1: "  ", model2: "   " },
    {}
  )
  assert.equal(saved.model1, "")
  assert.equal(saved.model2, "")
})

test("resolveReviewOptions prefers flag key over env over saved", () => {
  const resolved = resolveReviewOptions(
    { ...reviewDefaults, model: "openai:gpt-5.4", openaiApiKey: "sk-flag" },
    { openaiApiKey: "sk-saved" },
    { OPENAI_API_KEY: "sk-env" }
  )
  assert.equal(resolved.keys.openai, "sk-flag")
  assert.equal(
    resolveReviewOptions(
      { ...reviewDefaults, model: "openai:gpt-5.4" },
      { openaiApiKey: "sk-saved" },
      { OPENAI_API_KEY: "sk-env" }
    ).keys.openai,
    "sk-env"
  )
})

test("resolveReviewOptions resolves timeout flag over env over saved over default", () => {
  assert.equal(
    resolveReviewOptions({ ...reviewDefaults, model: "openai:gpt-5.4", openaiApiKey: "sk" }, {}, {}).timeout,
    DEFAULT_TIMEOUT
  )
  assert.equal(
    resolveReviewOptions(
      { ...reviewDefaults, model: "openai:gpt-5.4", openaiApiKey: "sk" },
      { timeout: "90" },
      {}
    ).timeout,
    90
  )
  assert.equal(
    resolveReviewOptions(
      { ...reviewDefaults, model: "openai:gpt-5.4", openaiApiKey: "sk" },
      { timeout: "90" },
      { TIMEOUT: "60" }
    ).timeout,
    60
  )
  assert.equal(
    resolveReviewOptions(
      { ...reviewDefaults, model: "openai:gpt-5.4", openaiApiKey: "sk", timeout: "180" },
      { timeout: "90" },
      { TIMEOUT: "60" }
    ).timeout,
    180
  )
  assert.throws(
    () =>
      resolveReviewOptions(
        { ...reviewDefaults, model: "openai:gpt-5.4", openaiApiKey: "sk", timeout: "0" },
        {},
        {}
      ),
    /positive integer/
  )
  assert.throws(
    () =>
      resolveReviewOptions(
        { ...reviewDefaults, model: "openai:gpt-5.4", openaiApiKey: "sk", timeout: "1.5" },
        {},
        {}
      ),
    /positive integer/
  )
})

test("runCli --timeout --save persists timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kolpo-"))
  const file = join(dir, "config.json")
  writeFileSync(file, JSON.stringify({ model: "openai:gpt-5.4", openaiApiKey: "sk" }, null, 2) + "\n")
  execFileSync("git", ["-c", "init.templateDir=", "init"], { cwd: dir })
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir })
  writeFileSync(join(dir, "f.txt"), "a\n")
  execFileSync("git", ["add", "f.txt"], { cwd: dir })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir })
  const prev = process.env.KOLPO_CONFIG
  const cwd = process.cwd()
  process.env.KOLPO_CONFIG = file
  process.chdir(dir)
  try {
    assert.equal(await runCli(["--timeout", "180", "--save"]), 0)
    assert.equal(loadConfig(file).timeout, "180")
  } finally {
    process.chdir(cwd)
    if (prev === undefined) delete process.env.KOLPO_CONFIG
    else process.env.KOLPO_CONFIG = prev
  }
})

test("runCli --save does not persist when primary model resolution fails", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "kolpo-")), "config.json")
  const original = {
    model: "anthropic:claude-sonnet-4-6",
    model1: "zai:glm-5.3",
    anthropicApiKey: "sk-ant",
    zaiApiKey: "sk-zai",
  }
  writeFileSync(file, JSON.stringify(original, null, 2) + "\n")
  const prev = process.env.KOLPO_CONFIG
  process.env.KOLPO_CONFIG = file
  const errors = []
  const origErr = console.error
  console.error = (...args) => errors.push(args.join(" "))
  try {
    assert.equal(await runCli(["--model", "nope", "--model-1=", "--model-2=", "--save"]), 1)
    assert.deepEqual(loadConfig(file), original)
    assert.match(errors.join("\n"), /must be provider:id|unknown provider|model spec/)
  } finally {
    console.error = origErr
    if (prev === undefined) delete process.env.KOLPO_CONFIG
    else process.env.KOLPO_CONFIG = prev
  }
})

test("runCli config set writes provider key and model to KOLPO_CONFIG", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "kolpo-")), "config.json")
  const prev = process.env.KOLPO_CONFIG
  process.env.KOLPO_CONFIG = file
  try {
    assert.equal(await runCli(["config", "set", "anthropic-api-key", "sk-stored"]), 0)
    assert.equal(await runCli(["config", "set", "model", "anthropic:claude-sonnet-4-6"]), 0)
    assert.deepEqual(loadConfig(file), { anthropicApiKey: "sk-stored", model: "anthropic:claude-sonnet-4-6" })
    assert.equal(await runCli(["config", "unset", "anthropic-api-key"]), 0)
    assert.deepEqual(loadConfig(file), { model: "anthropic:claude-sonnet-4-6" })
  } finally {
    if (prev === undefined) delete process.env.KOLPO_CONFIG
    else process.env.KOLPO_CONFIG = prev
  }
})

test("reviewMarkdownName uses REVIEW_randomKey.md", () => {
  assert.equal(reviewMarkdownName("abc123"), "REVIEW_abc123.md")
  assert.match(reviewMarkdownName(), /^REVIEW_[0-9a-f]{8}\.md$/)
})

test("writeReviewMarkdown writes unique REVIEW_*.md files", () => {
  const dir = mkdtempSync(join(tmpdir(), "kolpo-"))
  const first = writeReviewMarkdown(dir, "# hello")
  const second = writeReviewMarkdown(dir, "# again")
  assert.match(first, /^REVIEW_[0-9a-f]{8}\.md$/)
  assert.match(second, /^REVIEW_[0-9a-f]{8}\.md$/)
  assert.notEqual(first, second)
  assert.equal(readFileSync(join(dir, first), "utf8"), "# hello\n")
  assert.equal(readFileSync(join(dir, second), "utf8"), "# again\n")
})
