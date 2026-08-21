#!/usr/bin/env node
import { runCli } from "../src/cli.js"

runCli().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
)
