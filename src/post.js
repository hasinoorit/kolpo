import { execFileSync } from "node:child_process"
import { createInterface } from "node:readline/promises"
import { BOT_NAME } from "./config.js"
import {
  INLINE_MARKER,
  REVIEW_MARKER,
  createReview,
  createReviewComment,
  deleteReviewComment,
  dismissReview,
  findOpenPull,
  getAuthenticatedUser,
  isKolpoInlineBody,
  isKolpoReviewBody,
  listReviewComments,
  listReviews,
} from "./github.js"
import { gitHeadSha, gitRemoteUrl, parseGithubRemote } from "./git.js"

/**
 * @param {string} verdict
 * @returns {"APPROVE" | "COMMENT" | "REQUEST_CHANGES"}
 */
export function reviewEvent(verdict) {
  if (verdict === "approve") return "APPROVE"
  if (verdict === "request_changes") return "REQUEST_CHANGES"
  return "COMMENT"
}

/**
 * @param {string} event
 * @returns {string}
 */
export function eventLabel(event) {
  if (event === "APPROVE") return "approve"
  if (event === "REQUEST_CHANGES") return "request changes"
  return "comment"
}

/**
 * @param {string} [answer]
 * @returns {boolean}
 */
export function parseConfirm(answer) {
  const value = String(answer || "").trim().toLowerCase()
  return value === "y" || value === "yes"
}

/**
 * @param {{ isTTY?: boolean } | null | undefined} stdin
 * @returns {boolean}
 */
export function isInteractive(stdin = process.stdin) {
  return Boolean(stdin && stdin.isTTY)
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveGithubToken(env = process.env) {
  const fromEnv = (env.GITHUB_TOKEN || env.GH_TOKEN || "").trim()
  if (fromEnv) return fromEnv
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

/**
 * @param {string} body
 * @param {{ path: string, line: number, side: string, body: string }[]} comments
 */
export function withMarkers(body, comments) {
  return {
    body: body.includes(REVIEW_MARKER) ? body : `${REVIEW_MARKER}\n${body}`,
    comments: comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body.includes(INLINE_MARKER) ? comment.body : `${INLINE_MARKER}\n${comment.body}`,
    })),
  }
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {string[]} allowedLogins
 */
export async function dismissPriorKolpoReviews(token, owner, repo, pullNumber, allowedLogins) {
  const allowed = new Set(allowedLogins)
  const reviews = await listReviews(token, owner, repo, pullNumber)
  for (const rev of reviews) {
    const login = rev.user?.login
    if (!login || !allowed.has(login)) continue
    if (!isKolpoReviewBody(rev.body || "", BOT_NAME)) continue
    if (rev.state !== "CHANGES_REQUESTED" && rev.state !== "APPROVED") continue
    try {
      await dismissReview(token, owner, repo, pullNumber, rev.id, "Superseded by a new Kolpo review")
    } catch (err) {
      console.warn(`Could not dismiss review ${rev.id}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {string[]} allowedLogins
 */
export async function deletePriorKolpoComments(token, owner, repo, pullNumber, allowedLogins) {
  const allowed = new Set(allowedLogins)
  const comments = await listReviewComments(token, owner, repo, pullNumber)
  for (const comment of comments) {
    const login = comment.user?.login
    if (!login || !allowed.has(login)) continue
    if (!isKolpoInlineBody(comment.body || "")) continue
    try {
      await deleteReviewComment(token, owner, repo, comment.id)
    } catch (err) {
      console.warn(`Could not delete comment ${comment.id}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {string} commitId
 * @param {string} body
 * @param {import("./github.js").ReviewComment[]} comments
 * @param {"APPROVE" | "COMMENT" | "REQUEST_CHANGES"} event
 */
export async function submitReview(token, owner, repo, pullNumber, commitId, body, comments, event = "COMMENT") {
  /**
   * @param {string} eventToUse
   * @param {boolean} includeComments
   */
  const payload = (eventToUse, includeComments) => ({
    commit_id: commitId,
    event: eventToUse,
    body,
    comments: includeComments && comments.length ? comments : undefined,
  })

  try {
    return await createReview(token, owner, repo, pullNumber, payload(event, true))
  } catch (err) {
    if (event !== "COMMENT") {
      console.warn(`GitHub rejected ${event} (${err instanceof Error ? err.message : err}). Posting as COMMENT.`)
      event = "COMMENT"
      try {
        return await createReview(token, owner, repo, pullNumber, payload("COMMENT", true))
      } catch (err2) {
        if (!comments.length) throw err2
        console.warn(
          `Batch inline comments rejected (${err2 instanceof Error ? err2.message : err2}). Posting comments individually.`
        )
      }
    } else if (!comments.length) {
      throw err
    } else {
      console.warn(
        `Batch inline comments rejected (${err instanceof Error ? err.message : err}). Posting comments individually.`
      )
    }
  }

  let posted = 0
  for (const comment of comments) {
    try {
      await createReviewComment(token, owner, repo, pullNumber, { commit_id: commitId, ...comment })
      posted += 1
    } catch (err) {
      console.warn(`Inline comment ${comment.path}:${comment.line} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  console.log(`Posted ${posted}/${comments.length} inline comments individually`)
  return createReview(token, owner, repo, pullNumber, payload(event, false))
}

/**
 * @param {{
 *   token: string,
 *   owner: string,
 *   repo: string,
 *   pullNumber: number,
 *   commitId: string,
 *   body: string,
 *   comments: { path: string, line: number, side: string, body: string }[],
 *   event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
 *   allowedLogins: string[],
 * }} input
 */
export async function postPullReview(input) {
  const posted = withMarkers(input.body, input.comments)
  await dismissPriorKolpoReviews(input.token, input.owner, input.repo, input.pullNumber, input.allowedLogins).catch(
    (e) => console.warn(`Could not dismiss old reviews: ${e.message}`)
  )
  await deletePriorKolpoComments(input.token, input.owner, input.repo, input.pullNumber, input.allowedLogins).catch(
    (e) => console.warn(`Could not delete old comments: ${e.message}`)
  )
  const review = await submitReview(
    input.token,
    input.owner,
    input.repo,
    input.pullNumber,
    input.commitId,
    posted.body,
    posted.comments,
    input.event
  )
  return { ...posted, review }
}

/**
 * @param {string} event
 * @param {NodeJS.ReadStream} [stdin]
 * @param {NodeJS.WriteStream} [stdout]
 * @returns {Promise<boolean>}
 */
export async function askToPost(event, stdin = process.stdin, stdout = process.stdout) {
  if (!isInteractive(stdin)) return false
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = await rl.question(`Post this review to the open GitHub PR as ${eventLabel(event)}? [y/N] `)
    return parseConfirm(answer)
  } finally {
    rl.close()
  }
}

/**
 * @param {{
 *   cwd: string,
 *   branch: string,
 *   result: { body: string, inline: { path: string, line: number, side: string, body: string }[], review: { verdict: string } },
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 *   env?: NodeJS.ProcessEnv,
 * }} input
 */
export async function maybePostToGithub(input) {
  const stdin = input.stdin ?? process.stdin
  const stdout = input.stdout ?? process.stdout
  const env = input.env ?? process.env
  const event = reviewEvent(input.result.review.verdict)
  const confirmed = await askToPost(event, stdin, stdout)
  if (!confirmed) return

  const token = resolveGithubToken(env)
  if (!token) {
    console.error("GitHub token missing. Set GITHUB_TOKEN or GH_TOKEN, or run gh auth login.")
    return
  }

  let remote
  try {
    remote = parseGithubRemote(gitRemoteUrl(input.cwd))
  } catch (err) {
    console.error(`Could not read git origin: ${err instanceof Error ? err.message : err}`)
    return
  }
  if (!remote) {
    console.error("Could not parse origin as a GitHub remote.")
    return
  }

  const pr = await findOpenPull(token, remote.owner, remote.repo, input.branch, env)
  if (!pr) {
    console.log(`No open PR for branch ${input.branch}.`)
    return
  }

  const head = gitHeadSha(input.cwd)
  if (head !== pr.head.sha) {
    console.error(
      `Local HEAD ${head.slice(0, 7)} differs from PR #${pr.number} (${pr.head.sha.slice(0, 7)}). Push first.`
    )
    return
  }

  let login = ""
  try {
    login = (await getAuthenticatedUser(token, env)).login || ""
  } catch (err) {
    console.warn(`Could not resolve GitHub user: ${err instanceof Error ? err.message : err}`)
  }

  const posted = await postPullReview({
    token,
    owner: remote.owner,
    repo: remote.repo,
    pullNumber: pr.number,
    commitId: pr.head.sha,
    body: input.result.body,
    comments: input.result.inline,
    event,
    allowedLogins: login ? [login] : [],
  })
  const url = posted.review?.html_url || pr.html_url || `https://github.com/${remote.owner}/${remote.repo}/pull/${pr.number}`
  console.log(`Posted review: ${url}`)
}
