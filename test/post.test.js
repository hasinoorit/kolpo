import { test } from "node:test"
import assert from "node:assert/strict"
import { INLINE_MARKER, REVIEW_MARKER } from "../src/github.js"
import { parseGithubRemote } from "../src/git.js"
import { eventLabel, isInteractive, parseConfirm, reviewEvent, withMarkers } from "../src/post.js"

test("reviewEvent maps verdicts to GitHub review events", () => {
  assert.equal(reviewEvent("approve"), "APPROVE")
  assert.equal(reviewEvent("comment"), "COMMENT")
  assert.equal(reviewEvent("request_changes"), "REQUEST_CHANGES")
  assert.equal(reviewEvent("other"), "COMMENT")
})

test("eventLabel is the prompt wording for each event", () => {
  assert.equal(eventLabel("APPROVE"), "approve")
  assert.equal(eventLabel("REQUEST_CHANGES"), "request changes")
  assert.equal(eventLabel("COMMENT"), "comment")
})

test("parseConfirm accepts only y/yes", () => {
  assert.equal(parseConfirm("y"), true)
  assert.equal(parseConfirm("Y"), true)
  assert.equal(parseConfirm(" yes "), true)
  assert.equal(parseConfirm("n"), false)
  assert.equal(parseConfirm(""), false)
  assert.equal(parseConfirm("no"), false)
  assert.equal(parseConfirm(undefined), false)
})

test("isInteractive is false without a TTY", () => {
  assert.equal(isInteractive({}), false)
  assert.equal(isInteractive({ isTTY: false }), false)
  assert.equal(isInteractive({ isTTY: true }), true)
  assert.equal(isInteractive(null), false)
})

test("parseGithubRemote handles ssh, https, and git+https", () => {
  assert.deepEqual(parseGithubRemote("git@github.com:hasinoorit/kolpo.git"), {
    host: "github.com",
    owner: "hasinoorit",
    repo: "kolpo",
  })
  assert.deepEqual(parseGithubRemote("https://github.com/hasinoorit/kolpo.git"), {
    host: "github.com",
    owner: "hasinoorit",
    repo: "kolpo",
  })
  assert.deepEqual(parseGithubRemote("https://github.com/hasinoorit/kolpo"), {
    host: "github.com",
    owner: "hasinoorit",
    repo: "kolpo",
  })
  assert.deepEqual(parseGithubRemote("ssh://git@github.com/hasinoorit/kolpo.git"), {
    host: "github.com",
    owner: "hasinoorit",
    repo: "kolpo",
  })
  assert.deepEqual(parseGithubRemote("git+https://github.com/hasinoorit/kolpo.git"), {
    host: "github.com",
    owner: "hasinoorit",
    repo: "kolpo",
  })
  assert.equal(parseGithubRemote(""), null)
  assert.equal(parseGithubRemote("not-a-remote"), null)
})

test("withMarkers prefixes review and inline bodies", () => {
  const posted = withMarkers("hello", [
    { path: "a.js", line: 1, side: "RIGHT", body: "note", lineContent: "const x = 1" },
  ])
  assert.equal(posted.body, `${REVIEW_MARKER}\nhello`)
  assert.deepEqual(posted.comments, [
    { path: "a.js", line: 1, side: "RIGHT", body: `${INLINE_MARKER}\nnote` },
  ])
  const again = withMarkers(posted.body, posted.comments)
  assert.equal(again.body, posted.body)
  assert.equal(again.comments[0].body, posted.comments[0].body)
})
