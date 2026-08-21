export const REVIEW_MARKER = "<!-- kolpo-review -->"
export const INLINE_MARKER = "<!-- kolpo-inline -->"

const API_VERSION = "2022-11-28"

/**
 * @typedef {object} Pull
 * @property {number} number
 * @property {string} title
 * @property {string | null} body
 * @property {{ sha: string }} head
 * @property {{ sha: string }} base
 * @property {string} [html_url]
 */

/**
 * @typedef {object} ReviewComment
 * @property {string} path
 * @property {number} line
 * @property {"LEFT" | "RIGHT"} side
 * @property {string} body
 */

/**
 * @typedef {object} GhReview
 * @property {number} id
 * @property {string} state
 * @property {string | null} body
 * @property {{ login: string } | null} user
 */

/**
 * @typedef {object} GhReviewComment
 * @property {number} id
 * @property {string} body
 * @property {{ login: string } | null} user
 */

/**
 * @param {string | null} link
 * @returns {string | null}
 */
export function nextPageUrl(link) {
  if (!link) return null
  for (const part of link.split(",")) {
    const trimmed = part.trim()
    if (!trimmed.includes('rel="next"')) continue
    const match = trimmed.match(/<([^>]+)>/)
    if (match) return match[1]
  }
  return null
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function githubApiBase(env = process.env) {
  return (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "")
}

/**
 * @param {string} token
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{ status: number, text: string, json: any, headers: Headers }>}
 */
async function githubFetch(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "kolpo",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let json = {}
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = { message: text.slice(0, 500) }
    }
  }
  return { status: res.status, text, json, headers: res.headers }
}

/**
 * @param {string} token
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function githubJson(token, url, init = {}) {
  const res = await githubFetch(token, url, init)
  if (res.status === 204) return null
  if (res.status < 200 || res.status >= 300) {
    const message = res.json?.message || res.text.slice(0, 500) || res.status
    throw new Error(`GitHub ${res.status}: ${message}`)
  }
  return res.json
}

/**
 * @param {string} token
 * @param {string} url
 * @returns {Promise<any[]>}
 */
async function paginate(token, url) {
  const items = []
  let next = url
  while (next) {
    const res = await githubFetch(token, next)
    if (res.status < 200 || res.status >= 300) {
      const message = res.json?.message || res.text.slice(0, 500) || res.status
      throw new Error(`GitHub ${res.status}: ${message}`)
    }
    items.push(...(Array.isArray(res.json) ? res.json : []))
    next = nextPageUrl(res.headers.get("link"))
  }
  return items
}

/**
 * @param {string} api
 * @param {string} owner
 * @param {string} repo
 * @param {string} path
 * @returns {string}
 */
function repoUrl(api, owner, repo, path) {
  return `${api}/repos/${owner}/${repo}${path}`
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} number
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Pull>}
 */
export async function getPull(token, owner, repo, number, env) {
  return githubJson(token, repoUrl(githubApiBase(env), owner, repo, `/pulls/${number}`))
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} commentId
 * @param {string} content
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function addIssueCommentReaction(token, owner, repo, commentId, content, env) {
  await githubJson(token, repoUrl(githubApiBase(env), owner, repo, `/issues/comments/${commentId}/reactions`), {
    method: "POST",
    body: JSON.stringify({ content }),
  })
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {{ commit_id: string, event: string, body: string, comments?: ReviewComment[] }} payload
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<any>}
 */
export async function createReview(token, owner, repo, pullNumber, payload, env) {
  return githubJson(token, repoUrl(githubApiBase(env), owner, repo, `/pulls/${pullNumber}/reviews`), {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

/**
 * @param {string} token
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ login: string }>}
 */
export async function getAuthenticatedUser(token, env) {
  return githubJson(token, `${githubApiBase(env)}/user`)
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Pull[]>}
 */
export async function listOpenPullsByHead(token, owner, repo, branch, env) {
  const head = encodeURIComponent(`${owner}:${branch}`)
  return githubJson(token, repoUrl(githubApiBase(env), owner, repo, `/pulls?state=open&head=${head}`))
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Pull | null>}
 */
export async function findOpenPull(token, owner, repo, branch, env) {
  const pulls = await listOpenPullsByHead(token, owner, repo, branch, env)
  return Array.isArray(pulls) && pulls[0] ? pulls[0] : null
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {{ commit_id: string } & ReviewComment} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function createReviewComment(token, owner, repo, pullNumber, payload, env) {
  await githubJson(token, repoUrl(githubApiBase(env), owner, repo, `/pulls/${pullNumber}/comments`), {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<GhReview[]>}
 */
export async function listReviews(token, owner, repo, pullNumber, env) {
  return paginate(token, repoUrl(githubApiBase(env), owner, repo, `/pulls/${pullNumber}/reviews?per_page=100`))
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {number} reviewId
 * @param {string} message
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function dismissReview(token, owner, repo, pullNumber, reviewId, message, env) {
  await githubJson(token, repoUrl(githubApiBase(env), owner, repo, `/pulls/${pullNumber}/reviews/${reviewId}/dismissals`), {
    method: "PUT",
    body: JSON.stringify({ message }),
  })
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<GhReviewComment[]>}
 */
export async function listReviewComments(token, owner, repo, pullNumber, env) {
  return paginate(token, repoUrl(githubApiBase(env), owner, repo, `/pulls/${pullNumber}/comments?per_page=100`))
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} commentId
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function deleteReviewComment(token, owner, repo, commentId, env) {
  await githubJson(token, repoUrl(githubApiBase(env), owner, repo, `/pulls/comments/${commentId}`), {
    method: "DELETE",
  })
}

export const GITHUB_ACTIONS_BOT = "github-actions[bot]"

/**
 * @param {string | undefined | null} login
 * @returns {boolean}
 */
export function isKolpoBotLogin(login) {
  return login === GITHUB_ACTIONS_BOT
}

/**
 * @param {string} body
 * @param {string} botName
 * @returns {boolean}
 */
export function isKolpoReviewBody(body, botName) {
  return body.includes(REVIEW_MARKER) || body.includes(botName)
}

/**
 * @param {string} body
 * @returns {boolean}
 */
export function isKolpoInlineBody(body) {
  return body.includes(INLINE_MARKER) || body.includes(REVIEW_MARKER)
}
