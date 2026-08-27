import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_TIMEOUT, parseTimeout, resolveTimeout } from "../src/config.js"

test("parseTimeout accepts positive integers", () => {
  assert.equal(parseTimeout("1"), 1)
  assert.equal(parseTimeout("120"), 120)
  assert.equal(parseTimeout(" 300 "), 300)
})

test("parseTimeout rejects empty, zero, negative, float, and non-numeric", () => {
  assert.throws(() => parseTimeout(""), /positive integer/)
  assert.throws(() => parseTimeout("0"), /positive integer/)
  assert.throws(() => parseTimeout("-1"), /positive integer/)
  assert.throws(() => parseTimeout("1.5"), /positive integer/)
  assert.throws(() => parseTimeout("abc"), /positive integer/)
})

test("resolveTimeout prefers flag over env over saved over default", () => {
  assert.equal(resolveTimeout(undefined, {}, {}), DEFAULT_TIMEOUT)
  assert.equal(resolveTimeout(undefined, {}, { timeout: "90" }), 90)
  assert.equal(resolveTimeout(undefined, { TIMEOUT: "60" }, { timeout: "90" }), 60)
  assert.equal(resolveTimeout("180", { TIMEOUT: "60" }, { timeout: "90" }), 180)
  assert.equal(resolveTimeout(undefined, { TIMEOUT: "  " }, { timeout: "90" }), 90)
})
