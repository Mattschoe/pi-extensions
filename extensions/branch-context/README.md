# pi-branch-context

A [Pi](https://pi.dev/) extension that keeps LLM work scoped to the current git branch.

This extension creates context files that live in: `.pi/branches/<branch>.md`. The body of the file is injected into the
prompt as a `<branch-context>` block with `WHAT THIS BRANCH IS ABOUT` / `WHAT THIS BRANCH IS NOT
ABOUT` plus scope rules.

This extension is particularly good at avoiding "scope creep" features that often
happen when working with LLM's. When a developer asks for implementation work that is out of scope, 
the agent calls the `branch_scope_choice` tool, which blocks with:

- **Implement it here on `<branch>`:** Proceed on the current branch.
- **Create a separate branch for this:** The agent decides the base (main vs current HEAD,
  based on whether the work depends on this branch's state), the branch name, and how to handle a
  dirty tree (commit/stash with your awareness), then commits and reports clearly.

## Install

```sh
pi install npm:pi-branch-context
```

## Quick start

You can either run the context file scaffolding yourself with:
```sh
/branch-scaffold
```
Or wait for the LLM to prompt you for one. When working on a branch without
a context file its going to get injected with a prompt to ask the developer (you)
for permission to create one.

## Config

The extension includes configs that can be changed in:
- **Project scope:** `.pi/branch-context.json`
- **Global scope:** `~/.pi/agent/branch-context.json`
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
**`inject`**
- `per-session`: (default) injects once per session per branch
- `every-turn` appends the block to the system prompt on every prompt (useful if you do mid-session `git checkout`)


`excludeBranches`: 
is a tiny glob: `*` matches any characters (including `/`), `?` matches one character, everything else matches literally.

`staleThresholdCommits: 0`: 
disables the stale flag. The stale flag compares the `tip` in the file's frontmatter to HEAD via `git rev-list --count <tip>..HEAD`.

## Context file format example

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

## Behavior details

- **Injection**: skipped for excluded branches, non-git cwd, detached HEAD, unborn branches, and
  untrusted projects (pi's trust model gates all project-file access).
- **Missing context file**: one notice per session per branch offering `/branch-scaffold`; never
  nags again. The notice line is always shown; with `suggestScaffold: true` (default) it also
  carries agent guidance to proactively offer creating the file and, on agreement, write it itself
  (same spec as `/branch-scaffold`). Set `suggestScaffold: false` for the plain notice only.
- **`branch_scope_choice` tool**: only active while a context file is active.
  In non-interactive modes it returns a "no UI available" result instead of showing a dialog.
- **Pruning**: `.pi/branches/<branch>.md` is hard-deleted only when the branch has neither a local
  ref nor a remote-tracking ref. Runs non-blocking on session start and on branch change.
  Deletions are appended to `.pi/branches/.prune.log`.
