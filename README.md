# Kolpo

AI code review CLI and GitHub Action. Point it at a local branch or a pull
request: the diff plus the full contents of changed files go in; a structured
review with inline comments comes out. Plain Node.js, no dependencies, no build.

By default the primary model reviews each change. Set `model-1` and `model-2`
to review in parallel first; the primary then reviews independently and merges
in only the secondary findings that are new and real. Leave a secondary empty
to drop that slot.

Each slot is `provider:id`. Providers are `anthropic`, `openai`, `gemini`
(Google AI Studio), and `openrouter`. The primary model is required. Only the
API keys for providers you actually use must be set. A failed secondary is
dropped; a failed primary fails the run after one retry on that same model.

## CLI

Needs Node 22+. Install once, then run `kolpo` in any repo. `kolpo --help`
prints usage.

```bash
npm install -g kolpo
kolpo --help
kolpo config set anthropic-api-key sk-ant-...
kolpo config set openai-api-key sk-...
kolpo config set gemini-api-key AIza...
kolpo config set model anthropic:claude-sonnet-4-6
kolpo config set model-1 openai:gpt-5.4
kolpo config set model-2 gemini:gemini-2.5-pro
kolpo config
kolpo
```

Or without a global install: `npx kolpo`. Persist flags from a review invocation with `--save`:

```bash
kolpo --anthropic-api-key sk-ant-... --model anthropic:claude-sonnet-4-6 --save
kolpo --gemini-api-key AIza... --model gemini:gemini-2.5-pro --save
```

Config lives at `~/.config/kolpo/config.json` (override with `KOLPO_CONFIG`).
API keys are stored with mode `600` and are masked in `kolpo config` output.

A positional argument is the base ref: `kolpo main` is the same as `kolpo --base main`.
Plain `kolpo` uses the saved base, else `origin/HEAD`, then `main`, then `master`.

```bash
kolpo main
kolpo --base origin/dev
kolpo --model gemini:gemini-2.5-pro
kolpo --model anthropic:claude-sonnet-4-6 --model-1 openai:gpt-5.4 --model-2 gemini:gemini-2.5-pro
kolpo --model openai:gpt-5.4 --model-1 "" --model-2 ""
kolpo config unset model-2
kolpo config path
```

Flags (override saved config for this run):

- `--base <ref>` — base branch or commit (or pass it as `kolpo <ref>`; default: saved, else `origin/HEAD`, then `main`, then `master`)
- `--model <provider:id>` — primary model (required: flag or saved config)
- `--model-1 <provider:id>` — first secondary, or empty to disable (default: saved, else disabled)
- `--model-2 <provider:id>` — second secondary, or empty to disable (default: saved, else disabled)
- `--anthropic-api-key <key>` — Anthropic key (overrides `ANTHROPIC_API_KEY` and saved config)
- `--openai-api-key <key>` — OpenAI key (overrides `OPENAI_API_KEY` and saved config)
- `--gemini-api-key <key>` — Google AI Studio key (overrides `GEMINI_API_KEY` and saved config)
- `--openrouter-api-key <key>` — OpenRouter key (overrides `OPENROUTER_API_KEY` and saved config)
- `--extra-instructions <text>` — project-specific guidance appended to the system prompt
- `--save` — write the flags you passed to the config file

A provider's key is required only when a slot uses that provider. Flag beats env beats saved config.

The CLI writes the review to `REVIEW_<key>.md` in the current directory and
prints that filename. The file matches a GitHub PR review: the same summary
body, then each inline comment under its file with the quoted line.

If stdin is a terminal, Kolpo then asks whether to post that review to the
open GitHub PR (`Post this review … as approve|comment|request changes? [y/N]`). Default is no. Scripts and pipes skip the prompt.

Posting uses `GITHUB_TOKEN` or `GH_TOKEN`, or `gh auth token` after
`gh auth login`. The review appears as **the GitHub account that owns the
token** (usually you); the body still says Kolpo. You must have an open PR
for the current branch, and local `HEAD` must match the PR head — push
first if they differ. GitHub will not let you approve or request changes on
your own PR; Kolpo falls back to a comment in that case.

Exit status is `1` when the verdict is `request_changes` or the run fails.

## GitHub Action

Reviews when a PR is **opened** (unless it's a draft), a draft is marked
**ready for review**, or someone comments **`/review`** or **`/kolpo`** as its
own line (optional text after a space is fine). The sample workflow starts the
job on a `/review` or `/kolpo` substring; the Action then requires the command
on its own line, skips drafts, and no-ops on an empty PR diff. The sample also
skips PRs labeled **`no-ai-review`**.

It does **not** re-review on every push — ask with `/review` when you want a
fresh pass. The posted GitHub review uses the verdict: **Approve**,
**Comment**, or **Request changes**. Approve requires the repo setting
**Allow GitHub Actions to create and approve pull requests** (Settings →
Actions → General). Without it, Kolpo falls back to a comment; the body
still shows `Kolpo — approve`. Reviewer name is `github-actions[bot]`.

Old Kolpo reviews are collapsed as outdated when a new one posts.
Add the `no-ai-review` label to a PR to keep the bot out entirely.

Add `.github/workflows/review.yml`:

```yaml
name: kolpo
on:
  pull_request:
    types: [opened, ready_for_review]
  issue_comment:
    types: [created]
concurrency:
  group: kolpo-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true
permissions:
  contents: read
  pull-requests: write
  issues: write
jobs:
  review:
    if: >
      (github.event_name == 'pull_request' &&
       github.event.pull_request.draft == false &&
       !contains(github.event.pull_request.labels.*.name, 'no-ai-review')) ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       !contains(github.event.issue.labels.*.name, 'no-ai-review') &&
       (contains(github.event.comment.body, '/review') ||
        contains(github.event.comment.body, '/kolpo')))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event_name == 'issue_comment' && format('refs/pull/{0}/head', github.event.issue.number) || '' }}
      - uses: hasinoorit/kolpo@master
        with:
          model: anthropic:claude-sonnet-4-6
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # model-1: openai:gpt-5.4
          # openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          # model-2: gemini:gemini-2.5-pro
          # gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          # extra-instructions: |
          #   This is a payments service; scrutinize idempotency and rounding.
```

Gemini (Google AI Studio) as the primary reviewer:

```yaml
      - uses: hasinoorit/kolpo@master
        with:
          model: gemini:gemini-2.5-pro
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
```

Then add the secrets for the providers you use (repo → Settings → Secrets → Actions).

## Test

```bash
node --test test/*.test.js
```

