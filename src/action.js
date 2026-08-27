import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_MODEL_1, DEFAULT_MODEL_2, resolveTimeout } from "./config.js"
import { gitDiffRange, gitFetchShas } from "./git.js"
import { addIssueCommentReaction, getPull, GITHUB_ACTIONS_BOT } from "./github.js"
import { parseModel, resolveProviderKeys } from "./models.js"
import { postPullReview, reviewEvent, withMarkers } from "./post.js"
import { runReview } from "./review.js"

/**
 * @param {string | undefined | null} body
 * @returns {boolean}
 */
export function isReviewCommand(body) {
  for (const line of String(body || "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === "/review" || trimmed === "/kolpo") return true
    if (trimmed.startsWith("/review ") || trimmed.startsWith("/kolpo ")) return true
  }
  return false
}

export async function runAction() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH not set — run in a GitHub Action or point it at an event JSON file")
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error("GITHUB_TOKEN not set")

  const event = JSON.parse(readFileSync(eventPath, "utf8"))
  const [owner, repo] = event.repository.full_name.split("/")
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()

  let pr = event.pull_request
  if (!pr && event.issue?.pull_request) {
    if (!isReviewCommand(event.comment?.body)) {
      console.log("Comment is not a /review or /kolpo command")
      return
    }
    pr = await getPull(token, owner, repo, event.issue.number)
    if (pr.draft) {
      console.log("Skipping review on a draft pull request")
      return
    }
    await addIssueCommentReaction(token, owner, repo, event.comment.id, "eyes").catch(() => {})
  }
  if (!pr) throw new Error("Event has no pull_request — trigger on pull_request or PR issue_comment events")

  try {
    gitFetchShas(workspace, [pr.base.sha, pr.head.sha])
  } catch (err) {
    console.warn(`Could not fetch PR SHAs: ${err instanceof Error ? err.message : err}`)
  }
  const diff = gitDiffRange(workspace, pr.base.sha, pr.head.sha)
  if (!diff.trim()) {
    console.log("No changes in the pull request diff.")
    return
  }

  const model = (process.env.MODEL || "").trim()
  if (!model) throw new Error("MODEL not set")
  const model1 = (process.env.MODEL_1 ?? DEFAULT_MODEL_1).trim()
  const model2 = (process.env.MODEL_2 ?? DEFAULT_MODEL_2).trim()
  parseModel(model)
  if (model1) parseModel(model1)
  if (model2) parseModel(model2)
  const keys = resolveProviderKeys([model, model1, model2], {}, process.env, {})
  const timeout = resolveTimeout(undefined, process.env, {})
  console.log(`Chosen models: model=${model} model-1=${model1 || "(none)"} model-2=${model2 || "(none)"} timeout=${timeout}s`)

  const result = await runReview({
    diff,
    workspace,
    title: `PR #${pr.number}: ${pr.title}`,
    body: pr.body ?? "",
    extraInstructions: process.env.EXTRA_INSTRUCTIONS,
    primaryModel: model,
    secondaryModel: model1,
    secondaryModel2: model2,
    keys,
    timeout,
  })

  const posted = withMarkers(result.body, result.inline)
  const reviewEventName = reviewEvent(result.review.verdict)

  if (process.env.DRY_RUN) {
    console.log(JSON.stringify({ event: reviewEventName, ...posted }, null, 2))
    return
  }

  const submitted = await postPullReview({
    token,
    owner,
    repo,
    pullNumber: pr.number,
    commitId: pr.head.sha,
    body: result.body,
    comments: result.inline,
    event: reviewEventName,
    allowedLogins: [GITHUB_ACTIONS_BOT],
  })
  const url = submitted.review?.html_url ? ` ${submitted.review.html_url}` : ""
  console.log(
    `Posted ${reviewEventName} review:${url} ${posted.comments.length} inline comment(s), ${result.overflow.length} in summary`
  )
}

const isDirect = Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isDirect) {
  runAction().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
