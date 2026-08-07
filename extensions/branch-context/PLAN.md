# PLAN — branch-context extension (final design)

Supersedes the earlier notes/gh-issue draft (notes files, `/branch-note`, gh-issue helper, and
`.archive` concepts are all dropped). This is the design that was implemented.

## Goal

A pi extension that keeps LLM work scoped to the current git branch. On non-excluded branches, a
`WHAT THIS BRANCH IS ABOUT / NOT ABOUT` context file lives in the project config dir
(`.pi/branches/`) and is injected into the prompt. When a user asks for implementation work that is
out of scope for the branch, the agent must **ask first** via a blocking choice dialog
("implement here, or on a separate branch?") instead of silently polluting the branch — and never
silently defer. Explicit user asks always win; read-only/trivial requests never trigger the ask.

## Locked decisions

- Context files live in the project config dir (`.pi/branches/`); whether they are git-tracked is
  the team's `.gitignore` decision — the extension never forces either.
- Pruning = **hard delete only when the branch has neither a local ref nor a remote-tracking ref**;
  must be **non-blocking** (local git checks only, no network, no startup wait).
- Deferral = **blocking questionnaire** (`branch_scope_choice` tool → `ctx.ui.select`), with options
  "Implement it here on `<branch>`" / "Create a separate branch for this". **No notes files, no
  `/branch-note`, no gh-issue helper.**
- When the user picks "separate branch", the **LLM decides** the base (main tip vs current HEAD,
  based on whether the fix depends on this branch's state), the branch name, and the end state; it
  must commit and report clearly.
- Injection cadence + token cap are **config options**: `per-session` (default) vs `every-turn`;
  `maxWords` default 300.
- Source of truth: `extensions/branch-context/` in the `pi-extensions` repo; install for testing via
  symlink into `~/.pi/agent/extensions/`.
- Package name for sharing: `pi-branch-context` (plain `branch-context` is taken on npm).
  Publishing is conditional on testing approval.

## Feasibility (verified against pi 0.83.0 dist)

- pi's agent has no native questionnaire tool; extensions register custom tools via
  `pi.registerTool()` (callable immediately, refreshed without `/reload`), and `ctx.ui.select`
  blocks until the user picks — exactly the "waits for user response" requirement
  (`dist/core/extensions/types.d.ts`: `ExtensionUIContext.select` at line 70; `execute(..., ctx)` is
  an `ExtensionContext` with `ui`, `cwd`, `mode`, `hasUI`, `isProjectTrusted` at line 209).
- `before_agent_start` fires per prompt; returning `{ message }` persists the message as a
  `custom_message` session entry (`agent-session.js` `appendCustomMessageEntry`, line 359) that is
  projected back into context on resume (`session-manager.js` `sessionEntryToContextMessages`) — a
  per-session injection point with dedupe against existing entries.
- `pi.setActiveTools()` is a manual replace-list API; keep other tools by filtering
  `pi.getActiveTools()`.
- Symlinked `*.ts` files in `~/.pi/agent/extensions/` load (`loader.js`:
  `entry.isFile() || entry.isSymbolicLink()`).

## Implementation

Single file `extensions/index.ts` (loads via jiti; imports `@earendil-works/pi-coding-agent`
[`CONFIG_DIR_NAME`, `getAgentDir`, `ExtensionAPI`, `ExecResult`], `typebox` `Type`, and node
builtins). Reuses the `git-at.ts` exec pattern (`pi.exec("git", ["--no-optional-locks",
"-c", "color.ui=false", ...args], { cwd, timeout })`) and the framing-line convention
(provenance + relevance + "use as given instead of asking the user to restate").

### Config layer

`.pi/branch-context.json` (project, resolved via `CONFIG_DIR_NAME`) merges over global config (both
`~/.pi/branch-context.json` — the plan-documented path — and `~/.pi/agent/branch-context.json` — pi's
config convention, lower precedence) over defaults:

```jsonc
{ "enabled": true, "inject": "per-session", "maxWords": 300,
  "excludeBranches": ["main", "develop", "release/*"], "pruneOnStart": true,
  "staleThresholdCommits": 20, "suggestScaffold": true }
```

Malformed/missing files are ignored silently. `excludeBranches` uses a tiny glob (`*` = any chars
incl. `/`, `?` = one char, else literal). All project-file access (config, context read, prune,
scaffold) is gated on `ctx.isProjectTrusted()`.

### Repo/branch resolution

`git rev-parse --show-toplevel` then `git branch --show-current`. Returns null for non-git cwd,
detached HEAD, unborn branch → skip everywhere. Branch cached per repo; mismatch = mid-session
checkout → fire-and-forget prune.

### Injection (`before_agent_start`)

1. Trusted? enabled? resolve repo/branch. Excluded branch → deactivate tool, no injection.
2. `.pi/branches/<branch>.md` exists?
   - **Yes**: parse frontmatter (`branch`, `written_at`, `tip`, `generated`), truncate body past
     `maxWords` with a `…(truncated)` note, stale flag when `git rev-list --count <tip>..HEAD` >
     `staleThresholdCommits` (0 disables). Build the block:

     ```
     <branch-context branch="…" file=".pi/branches/…" written="…">
     <framing line: injected automatically — use as given instead of asking to restate>
     WHAT THIS BRANCH IS ABOUT: …
     WHAT THIS BRANCH IS NOT ABOUT: …
     <scope rules: explicit asks always win; call branch_scope_choice BEFORE out-of-scope
      implementation; read-only/trivial never ask; separate-branch → LLM decides base/name/
      dirty-tree handling, commits and reports>
     [may be stale: written at <tip>, HEAD now <hash>]
     </branch-context>
     ```

   - `every-turn` → append to `event.systemPrompt`. `per-session` → return `message` once per
     session per branch, deduped via an in-memory Set plus a scan of persisted `custom_message`
     entries (resume/reload).
   - **No**: one-time notice message per session per branch offering `/branch-scaffold`; never nag.
     When `suggestScaffold` is true (default), the notice also embeds agent guidance to proactively
     offer creating the file and, on agreement, write it itself (same spec as `/branch-scaffold`,
     shared `SCAFFOLD_TEMPLATE` const) — `false` yields the plain notice only.
3. Tool set sync: `branch_scope_choice` active only while a context file is active.

### Custom tool `branch_scope_choice`

`Type.Object({ branch, task, suggestedBranch? })`, `executionMode: "sequential"`, `execute` guards
`ctx.hasUI` (non-UI modes return a "no dialog, default to current branch" result), then
`await ctx.ui.select("Out-of-scope request", ["Implement it here on <branch>", "Create a separate
branch for this"])`. Returns the choice as content; cancelled dialogs tell the model to ask again
rather than silently proceed. `promptSnippet` + `promptGuidelines` name the tool explicitly.

### `/branch-scaffold` command

Delegates to the agent. The handler resolves `base` (merge-base with `main`/`origin/main`, falling
back to `HEAD~10`) and `tip` (short HEAD), then sends the agent a steer message via
`pi.sendUserMessage(..., { deliverAs: "followUp" })` naming the target file
(`.pi/branches/<branch>.md`), the required frontmatter (`branch`, `written_at`, `tip`,
`generated: true`), and instructions to: study the branch name / `git log <base>..HEAD` /
`git diff --stat <base>...HEAD`; ask the user questions when the branch's intent is genuinely
ambiguous; synthesize intent instead of pasting the log verbatim (concise, well under 300 words);
and remind the user to review for secrets. The handler writes nothing itself — the agent's write
tool creates the branch subdir (no mkdir/ENOENT path exists anymore). No deterministic draft is
generated.

### Pruning

Trigger: `session_start` (if `pruneOnStart`) and on branch change — both fire-and-forget with
`.catch`. One pass per repo per process (`pruneRan` set). Enumerate `.pi/branches/*.md` (skip
`main.md`, dotfiles); branch name = filename minus `.md`; skip current branch; keep if local ref
(`for-each-ref refs/heads/`, exact name) or remote-tracking ref (`for-each-ref refs/remotes/`,
suffix after the remote) exists; else `unlink` + append `.pi/branches/.prune.log`. Silent — no
confirmation prompts.

## Files

- `extensions/index.ts` — the extension (single file, jiti loads TS directly).
- `package.json` — `pi-branch-context`, `"pi": { "extensions": ["./extensions"] }`, BSD-3-Clause,
  peerDeps `@earendil-works/pi-coding-agent` + `typebox`, no runtime deps.
- `README.md` — what it does, install (npm + symlink), config schema, behavior, local-first note.
- `LICENSE` — copied from the repo root (BSD 3-Clause).
- `test/smoke.mjs` — load + behavior smoke test against a scratch repo.
- This `PLAN.md`.

## Install

Symlink `~/.pi/agent/extensions/branch-context.ts` →
`extensions/branch-context/extensions/index.ts` (symlinks load — verified in the loader). Anything
created under `~/.pi` requires `~/.local/bin/pi-backup` afterwards.

## Testing strategy (executed)

Scratch repo `/tmp/bc-test`: `main` + `feature/dark-mode` (slash branch) + `feature/auth` +
`fix/logout`, a few commits each; context file on `feature/dark-mode` and `fix/logout`; bare remote
for remote-tracking refs.

- Load: jiti-import the extension via pi's alias mechanism; factory is a function; tool + command
  registered.
- Injection: context present → block with ABOUT/NOT-ABOUT + framing; excluded branch (`main`) →
  nothing; missing file → one-time notice; per-session → once only; every-turn → systemPrompt
  append each call; tool activation toggled.
- Pruning: deleted branch (no local, no remote-tracking) → file hard-deleted + logged; kept when a
  remote-tracking ref exists; current branch never pruned; `main.md` never pruned.
- Stale flag: tip far behind HEAD → `[may be stale]` note.

Interactive (user): out-of-scope implementation request → dialog with both options; both paths
behave; read-only request → no dialog; `/branch-scaffold` in a real project; `/reload` clean load.

## Risks / residuals

- `ctx.ui.select` on tool-execute context — verified present (`ExtensionContext.ui`).
- Per-session message persistence — verified (`custom_message` entries); dedupe on resume via entry
  scan. If the message is compacted away mid-session, it is not re-injected (documented; use
  `every-turn`).
- Over-asking — mitigated by scope-rules text (read-only/trivial excluded).
- Under-asking — a weak model may silently implement out-of-scope work; rules text + tool
  guidelines mitigate; acceptable residual risk, noted in README.
- Tool activation lag of one turn after a mid-session branch switch (base prompt rebuild);
  the injected block names the tool so the model can still call it.
- Stale flag cost: one `rev-list --count` spawn per prompt in every-turn mode (few ms).
- Backup rule: `pi-backup` after touching `~/.pi`.

## Done when

- Extension loads cleanly (`/reload`, no errors); symlink present under `~/.pi/agent/extensions/`;
  `pi-backup` push succeeded.
- Out-of-scope request on a context-bearing branch produces the dialog with both options; both
  paths behave; excluded branches: no injection; missing context: one-time notice.
- Pruning deletes only branches with no local and no remote-tracking ref, non-blocking, logged,
  never the current branch.
- Config options honored. `README.md`/`package.json`/`PLAN.md` written; old notes/gh-issue/
  `.archive` concepts absent from the code.
- `suggestScaffold` (default `true`) parsed from config; the missing-file notice keeps its exact
  user-facing line in both modes; the guidance (proactive offer, no-source-reading, real
  branch/relFile/tip/base commands, structure template shared with the command via one const) is
  injected only when `suggestScaffold` is true; smoke test asserts both paths.
- `/branch-scaffold` delegates to the agent (`pi.sendUserMessage` + info notify; the command ctx
  lacks `sendUserMessage` at runtime, so the `pi.*` API is used, matching pi's own example
  commands); it writes no
  file itself; the steer message carries the exact-format + ask-questions + synthesize
  instructions; smoke test asserts the handoff (exactly one sent message, no file writes,
  slash-branch safe).
