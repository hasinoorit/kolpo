import { test } from "node:test"
import assert from "node:assert/strict"
import { isReviewCommand } from "../src/action.js"

test("isReviewCommand matches /review and /kolpo as a line", () => {
  assert.equal(isReviewCommand("/review"), true)
  assert.equal(isReviewCommand("/kolpo"), true)
  assert.equal(isReviewCommand("/review please"), true)
  assert.equal(isReviewCommand("  /kolpo now"), true)
  assert.equal(isReviewCommand("please take a look\n/review\nthanks"), true)
  assert.equal(isReviewCommand("/review\r\nmore"), true)
  assert.equal(isReviewCommand("/reviewed"), false)
  assert.equal(isReviewCommand("see /review in the docs"), false)
  assert.equal(isReviewCommand("https://example.com/review"), false)
  assert.equal(isReviewCommand(""), false)
  assert.equal(isReviewCommand(undefined), false)
})
