import { test } from "node:test"
import assert from "node:assert/strict"
import {
  INLINE_MARKER,
  REVIEW_MARKER,
  githubApiBase,
  isKolpoBotLogin,
  isKolpoInlineBody,
  isKolpoReviewBody,
  nextPageUrl,
} from "../src/github.js"

test("nextPageUrl reads rel=next from Link", () => {
  assert.equal(nextPageUrl(null), null)
  assert.equal(nextPageUrl(""), null)
  assert.equal(
    nextPageUrl('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'),
    "https://api.github.com/x?page=2"
  )
  assert.equal(nextPageUrl('<https://api.github.com/x?page=5>; rel="last"'), null)
})

test("githubApiBase uses GITHUB_API_URL without a trailing slash", () => {
  assert.equal(githubApiBase({}), "https://api.github.com")
  assert.equal(githubApiBase({ GITHUB_API_URL: "https://ghe.example/api/v3/" }), "https://ghe.example/api/v3")
})

test("isKolpoBotLogin matches github-actions bot", () => {
  assert.equal(isKolpoBotLogin("github-actions[bot]"), true)
  assert.equal(isKolpoBotLogin("someone-else"), false)
  assert.equal(isKolpoBotLogin(null), false)
})

test("isKolpoReviewBody matches marker or bot name", () => {
  assert.equal(isKolpoReviewBody(`${REVIEW_MARKER}\nhello`, "Kolpo"), true)
  assert.equal(isKolpoReviewBody("Kolpo review", "Kolpo"), true)
  assert.equal(isKolpoReviewBody("unrelated", "Kolpo"), false)
})

test("isKolpoInlineBody matches inline or review markers", () => {
  assert.equal(isKolpoInlineBody(`${INLINE_MARKER}\nnote`), true)
  assert.equal(isKolpoInlineBody(`${REVIEW_MARKER}\nnote`), true)
  assert.equal(isKolpoInlineBody("plain note"), false)
})
