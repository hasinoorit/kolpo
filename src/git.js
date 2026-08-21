import { execFileSync } from "node:child_process"

const DIFF_EXCLUDES = [
  ":(exclude)package-lock.json",
  ":(exclude)yarn.lock",
  ":(exclude)pnpm-lock.yaml",
  ":(exclude)bun.lock",
  ":(exclude)bun.lockb",
  ":(exclude)*.svg",
  ":(exclude)*.png",
  ":(exclude)*.jpg",
  ":(exclude)*.jpeg",
  ":(exclude)*.webp",
  ":(exclude)*.gif",
]

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {{ ignoreStderr?: boolean }} [extra]
 * @returns {string}
 */
function git(args, cwd, extra = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", extra.ignoreStderr ? "ignore" : "pipe"],
  })
}

/**
 * @param {string} cwd
 * @param {string} ref
 * @returns {boolean}
 */
export function refExists(cwd, ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", ref], cwd, { ignoreStderr: true })
    return true
  } catch {
    return false
  }
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function defaultBase(cwd) {
  for (const ref of ["origin/HEAD", "main", "master"]) {
    if (refExists(cwd, ref)) return ref
  }
  throw new Error("Could not determine a default base branch (tried origin/HEAD, main, then master). Pass --base.")
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function currentBranch(cwd) {
  try {
    return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd, { ignoreStderr: true }).trim() || "HEAD"
  } catch {
    return "HEAD"
  }
}

/**
 * @param {string} cwd
 * @param {string} base
 * @returns {string}
 */
export function gitDiff(cwd, base) {
  return gitDiffRange(cwd, base, "HEAD")
}

/**
 * @param {string} cwd
 * @param {string} base
 * @param {string} head
 * @returns {string}
 */
export function gitDiffRange(cwd, base, head) {
  return git(["diff", "--no-color", `${base}...${head}`, "--", ".", ...DIFF_EXCLUDES], cwd)
}

/**
 * @param {string} cwd
 * @param {string[]} shas
 */
export function gitFetchShas(cwd, shas) {
  git(["fetch", "--no-tags", "origin", ...shas], cwd)
}

/**
 * @param {string} cwd
 * @returns {string[]}
 */
export function gitLsFiles(cwd) {
  const out = git(["ls-files"], cwd, { ignoreStderr: true }).trim()
  return out ? out.split("\n") : []
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function gitHeadSha(cwd) {
  return git(["rev-parse", "HEAD"], cwd, { ignoreStderr: true }).trim()
}

/**
 * @param {string} cwd
 * @param {string} [name]
 * @returns {string}
 */
export function gitRemoteUrl(cwd, name = "origin") {
  return git(["remote", "get-url", name], cwd, { ignoreStderr: true }).trim()
}

/**
 * @typedef {{ host: string, owner: string, repo: string }} GithubRemote
 */

/**
 * @param {string} url
 * @returns {GithubRemote | null}
 */
export function parseGithubRemote(url) {
  if (!url) return null
  const trimmed = url.trim().replace(/\.git$/, "")
  const ssh = trimmed.match(/^git@([^:]+):([^/]+)\/(.+)$/)
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] }
  const sshUri = trimmed.match(/^ssh:\/\/git@([^/]+)\/([^/]+)\/(.+)$/)
  if (sshUri) return { host: sshUri[1], owner: sshUri[2], repo: sshUri[3] }
  try {
    const parsed = new URL(trimmed.replace(/^git\+/, ""))
    const parts = parsed.pathname.replace(/^\//, "").split("/").filter(Boolean)
    if (parts.length >= 2) return { host: parsed.host, owner: parts[0], repo: parts.slice(1).join("/") }
  } catch {
    return null
  }
  return null
}
