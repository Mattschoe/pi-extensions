# pi-branch-context

A [pi](https://pi.dev/) extension that keeps LLM work scoped to the current git branch.

On non-excluded branches, a scope context file lives at `.pi/branches/<branch>.md` (path mirrors
slashes: `feature/dark-mode` → `.pi/branches/feature/dark-mode.md`). Its body is injected into the
prompt as a `<branch-context>` block with `WHAT THIS BRANCH IS ABOUT` / `WHAT THIS BRANCH IS NOT
ABOUT` plus scope rules. When a user asks for **implementation work that is out of scope**, the
agent must first call the `branch_scope_choice` tool, which blocks on a dialog:

- **Implement it here on `<branch>`** — proceed on the current branch.
- **Create a separate branch for this** — the agent decides the base (main vs current HEAD,
  based on whether the work depends on this branch's state), the branch name, and how to handle a
  dirty tree (commit/stash with your awareness), then commits and reports clearly.

Explicit user asks always win. Read-only/trivial requests never trigger the dialog. The agent never
silently defers out-of-scope work.

- Local-first: no accounts, no telemetry, no network calls (pruning uses local git checks only).
- Whether the context files are git-tracked is your team's `.gitignore` decision — the extension
  never forces either.

## Install

```sh
# npm package
pi install npm:pi-branch-context

# or manual: symlink the extension into your agent extensions dir
ln -s ~/Projects/pi-extensions/extensions/branch-context/extensions/index.ts \
      ~/.pi/agent/extensions/branch-context.ts
```

Then `/reload` pi.

## Quick start

```sh
# on a feature branch:
/branch-scaffold        # the agent researches the branch (may ask questions) and
                        # writes .pi/branches/<branch>.md
# review the file — it is generated from git history, so check it for secrets
```

Now on that branch, prompts get the scope block injected, and out-of-scope implementation requests
produce the choice dialog.

## Config

Project config `.pi/branch-context.json` merges over global config over these defaults. Global
config is read from `~/.pi/agent/branch-context.json` (pi's config convention); `~/.pi/branch-context.json`
is also honored as a fallback:

```jsonc
{
  "enabled": true,                 // master switch
  "inject": "per-session",         // "per-session" | "every-turn"
  "maxWords": 300,                 // truncate the context body past this many words; 0 = no truncation
  "excludeBranches": ["main", "develop", "release/*"],
  "pruneOnStart": true,            // delete context files for deleted branches
  "staleThresholdCommits": 20,     // add a "[may be stale]" flag past this drift
  "suggestScaffold": true          // when no context file exists, have the agent proactively offer to create one
}
```

- `inject: "per-session"` (default) injects once per session per branch; `"every-turn"` appends the
  block to the system prompt on every prompt (catches mid-session `git checkout`, costs a little
  more every turn).
- `excludeBranches` is a tiny glob: `*` matches any characters (including `/`), `?` matches one
  character, everything else matches literally.
- `staleThresholdCommits: 0` disables the stale flag. The stale flag compares the `tip` in the
  file's frontmatter to HEAD via `git rev-list --count <tip>..HEAD`.

## Context file format

```markdown
---
branch: feature/dark-mode
written_at: 2026-08-07
tip: a1b2c3d
generated: true        # set when /branch-scaffold wrote the file
---

WHAT THIS BRANCH IS ABOUT:
Dark-mode theming across the app, following the design tokens in docs/theme.md.

WHAT THIS BRANCH IS NOT ABOUT:
Auth, payments, CI changes — those live on other branches.
```

`branch`, `written_at`, `tip` are optional; the block shows a stale note when HEAD has drifted more
than `staleThresholdCommits` past `tip`.

## Behavior details

- **Injection**: skipped for excluded branches, non-git cwd, detached HEAD, unborn branches, and
  untrusted projects (pi's trust model gates all project-file access).
- **Missing context file**: one notice per session per branch offering `/branch-scaffold`; never
  nags again. The notice line is always shown; with `suggestScaffold: true` (default) it also
  carries agent guidance to proactively offer creating the file and, on agreement, write it itself
  (same spec as `/branch-scaffold`). Set `suggestScaffold: false` for the plain notice only.
- **`branch_scope_choice` tool**: only active while a context file is active (keeps the prompt
  lean). In non-interactive modes it returns a "no UI available" result instead of showing a dialog.
- **Pruning**: `.pi/branches/<branch>.md` is hard-deleted only when the branch has neither a local
  ref nor a remote-tracking ref (local checks, no network). Runs non-blocking on session start and
  on branch change, at most one pass per repo per process, never deletes the current branch's file
  or `main.md`. Deletions are appended to `.pi/branches/.prune.log`.
- **`/branch-scaffold`**: hands off to the agent. It studies the branch name, `git log
  <merge-base>..HEAD` and `git diff --stat <merge-base>...HEAD` (base = merge-base with
  main/origin/main), infers the branch's intent, and — when anything is genuinely ambiguous — asks
  you questions before writing `.pi/branches/<branch>.md`. Files it writes carry `generated: true`;
  review the result for secrets (history can quote credentials).

## Known limitations

- A weak model may silently implement out-of-scope work instead of calling `branch_scope_choice`;
  the scope-rules text and tool guidelines mitigate this, but it is a residual risk.
- In `per-session` mode the injected message can be compacted away mid-session; switch to
  `every-turn` if you need guaranteed presence.
- Stale checks spawn one `git rev-list --count` per prompt (few ms) in every-turn mode.

## Development

```sh
# smoke test (loads the extension through jiti + drives the handlers against a scratch repo)
node test/smoke.mjs
```

Layout: `extensions/index.ts` (the extension), `test/smoke.mjs` (load + behavior smoke test),
`PLAN.md` (design). Source of truth lives in the `pi-extensions` repo under
`extensions/branch-context/`; local installs are symlinks into `~/.pi/agent/extensions/`.
