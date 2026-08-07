---
created: "2026-08-07T17:25:41.504Z"
mode: "plan"
session: "/home/matt/.pi/agent/sessions/--home-matt-Projects-pi-extensions--/2026-08-07T14-48-04-823Z_019fdcb2-0fd7-7d10-895b-1e9ca3249a6d.jsonl"
---

The harness just switched this session into plan mode (edits are now blocked — that's why the edit was rejected). I'll lay out the complete fix as a plan; it's ready to execute in a fresh session.

# Rework /branch-scaffold to be agent-driven

## Context

The user ran `/branch-scaffold` on branch `feat/mobile-support` in `/home/matt/Projects/SmartHome` and got a mechanically-generated file: a verbatim commit log, a useless NOT-ABOUT section ("does NOT touch: README.md"), and a raw diff stat. The user's expectation (correct): `/branch-scaffold` should have **the agent** look at the current commits, ask the user clarifying questions when the branch's intent is ambiguous, and write a proper context file — a branch-specific AGENTS.md with real `WHAT THIS BRANCH IS ABOUT` / `NOT ABOUT` content.

Root cause: per the original plan, the command was specced as a dumb deterministic draft (commit log + diff stat + touched-path complement) that the user would hand-edit. That design is wrong for this use case and is now rejected. The command must instead delegate the research-and-writing to the agent via a steer message.

Current state: source of truth at `/home/matt/Projects/pi-extensions/extensions/branch-context/`, committed and pushed at `932cb25` (includes the earlier `mkdir(dirname(filePath))` ENOENT fix — that fix becomes moot since the handler will no longer write files itself). Installed via symlink `~/.pi/agent/extensions/branch-context.ts → …/extensions/index.ts`. Smoke test `test/smoke.mjs` passes 54/54 and currently asserts the old deterministic behavior.

## Files to Read

1. `/home/matt/Projects/pi-extensions/extensions/branch-context/extensions/index.ts` — the scaffold command (~line 640 onward) and the dead helper functions (`findBase`, `readReadmeHead`, `touchedTopLevels`, `draftAbout`, `draftNotAbout`) plus imports.
2. `/home/matt/Projects/pi-extensions/extensions/branch-context/test/smoke.mjs` — the scaffold test block (asserts file writes, commit subjects, "a.txt" NOT-ABOUT, generated marker).
3. `/home/matt/Projects/pi-extensions/extensions/branch-context/README.md` and `PLAN.md` — sections describing the scaffold flow (need rewording).

## Files to Modify

- `extensions/index.ts`:
  - **Rework the `/branch-scaffold` command handler**: after the existing guard chain (trusted, enabled, repo+branch resolvable), compute `base = await findBase(pi, repo)`, `tip = await shortHead(pi, repo)`, `relFile = join(CONFIG_DIR_NAME, "branches", \`${branch}.md\`)`, then build a steer prompt (exact text in Plan step 2) and send it with `ctx.sendUserMessage(prompt, { deliverAs: "followUp" })` (verified: `ExtensionCommandContextActions.sendUserMessage` exists, `types.d.ts` ~line 1170; docs use it for command→agent handoff). Also `ctx.ui.notify("branch-context: generating ${relFile} — the agent will research the branch and may ask questions", "info")` before sending.
  - **Delete** `readReadmeHead`, `touchedTopLevels`, `draftAbout`, `draftNotAbout`, and the now-unused constants `MAX_SCAFFOLD_LOG_LINES`, `MAX_NOT_ABOUT_ITEMS`. Keep `findBase` and `shortHead` (their results are embedded in the steer message).
  - **Trim imports**: remove `readdirSync` (node:fs), `mkdir`, `writeFile` (node:fs/promises), `dirname` (node:path) — all only used by the deleted code. Keep `readFileSync`, `existsSync`, `appendFile`, `readdir`, `readFile`, `unlink`, `homedir`, `join`, `relative`.
  - Update the header comment bullet about `/branch-scaffold` (from "drafts a context file from git history" to "delegates to the agent, which researches the branch and asks questions if needed").
  - Update the missing-file notice text in `before_agent_start`: "Run /branch-scaffold to generate a draft" → "Run /branch-scaffold to have the agent write one".
- `test/smoke.mjs`:
  - Add `sendUserMessage(content, opts)` to `makeFakePi()`'s api object (record calls in a `sent` array on the returned fake, e.g. `sent.push(content)`).
  - Rewrite the scaffold test block: on `feature/auth`, call `scaffoldCmd.handler("", makeCtx(TEST_REPO, { notifySink }))` and assert the handler sent exactly one user message containing: the branch name, `.pi/branches/feature/auth.md`, `WHAT THIS BRANCH IS ABOUT`, `generated: true`, and the "ASK the user questions" instruction; assert the handler wrote **no** file (the pre-existing `feature/auth.md` content unchanged).
  - Slash-branch regression: on `feat/mobile-support` (create it with a commit; `feat/` subdir absent), run the handler and assert the sent message contains `.pi/branches/feat/mobile-support.md` and that the handler created no file and no `feat/` dir (agent writes it; no ENOENT path exists anymore).
  - Remove the old assertions (file exists with commit subjects / "a.txt" / generated marker).
- `README.md`:
  - Quick start: replace "drafts .pi/branches/<branch>.md from git history" with the agent-driven description ("the agent researches the branch, may ask questions, and writes the file").
  - Behavior details: update the `/branch-scaffold` bullet accordingly; keep the "review for secrets" note.
- `PLAN.md`: update the scaffold section + "Done when" to describe the agent-driven command.

## Files to Create

None.

## Plan

1. Read the current scaffold command + helpers in `extensions/index.ts` (locate exact blocks to delete).
2. Replace the handler body after the guard chain with the steer approach. Exact prompt text (join with `\n`):
   ```
   The user ran /branch-scaffold — create the branch-context file for branch "<branch>".

   Write "<relFile>" in this repo with EXACTLY this structure:
   ```
   ---
   branch: <branch>
   written_at: <today YYYY-MM-DD>
   tip: <tip or "<current short HEAD hash>">
   generated: true
   ---

   WHAT THIS BRANCH IS ABOUT:
   <concise statement of this branch's purpose and scope>

   WHAT THIS BRANCH IS NOT ABOUT:
   <what is deliberately out of scope — other areas/features this branch does NOT touch>
   ```
   How to write it well:
   1. Study the branch: the branch name, `git log --oneline <base>..HEAD` (or `HEAD` last 20 when no base), and `git diff --stat <base>...HEAD` (base computed as merge-base with main/origin/main).
   2. Infer the branch's intent from the name, commits, and diff. If anything is genuinely ambiguous, ASK the user questions first — do not guess.
   3. Synthesize intent; do NOT paste the commit log or diff stat verbatim. The file is injected into every prompt on this branch, so keep it concise (a few sentences per section, well under 300 words).
   4. Write the file, then report what you wrote and remind the user to review it for secrets (it is generated from git history).
   ```
   (Embed the actual `branch`, `relFile`, date, `tip`, `base` values; escape backticks in the TS template correctly.)
   Then `ctx.ui.notify(...)` + `ctx.sendUserMessage(prompt, { deliverAs: "followUp" })`. Note in a comment that the agent's write tool creates the branch subdir, so no mkdir is needed.
3. Delete the dead helpers/constants and trim imports (list above). Remove `dirname` usage entirely.
4. Update the header comment and the missing-file notice wording.
5. Update `test/smoke.mjs` (fake pi `sendUserMessage` + rewritten scaffold assertions, as described in Files to Modify). Ensure the tests still pass 54+ (the prune/injection sections are unaffected).
6. Update `README.md` and `PLAN.md` wording for the new flow.
7. Run `node test/smoke.mjs` from the package dir (expect all green).
8. Commit + push the repo (`git add -A && git commit && git push`). No `~/.pi` changes → no `pi-backup` needed (symlink target unchanged). Then tell the user to `/reload` and re-run `/branch-scaffold` in `/home/matt/Projects/SmartHome` — the agent should research `feat/mobile-support` and ask questions instead of dumping history.

## Risks

- The agent may still paste raw commit lists if it ignores instruction 3 — mitigated by the explicit "do NOT paste verbatim" line and the conciseness target; the block is also truncated to `maxWords` (300) at injection time, so a bad file is capped in damage.
- `ctx.sendUserMessage` in a command handler: verified present on the command context and used by pi's own examples (reload-runtime uses `pi.sendUserMessage` with `deliverAs: "followUp"`); if the fresh executor finds `ctx.sendUserMessage` missing at runtime, fall back to `pi.sendUserMessage(prompt, { deliverAs: "followUp" })` (also verified on `ExtensionAPI`).
- Over-asking: instruction 2 says ask only when genuinely ambiguous — acceptable.
- The old ENOENT mkdir fix becomes dead code but harmless; removing it is part of the refactor.

## Testing Strategy

- Smoke test (54 checks) re-run green, with the rewritten scaffold assertions: handler sends exactly one steer message containing branch/relFile/structure markers/"ASK the user questions"; handler writes no file; slash-branch case has no ENOENT path.
- User-level check in SmartHome on `feat/mobile-support`: `/reload`, `/branch-scaffold` → agent researches commits, asks at least one clarifying question, writes `.pi/branches/feat/mobile-support.md` with real ABOUT/NOT-ABOUT, warns about secrets; next prompt injects the block.

## Done When

- `/branch-scaffold` no longer writes the file itself; it delegates to the agent via `ctx.sendUserMessage` with the exact-format + ask-questions + synthesize instructions.
- Dead deterministic helpers and their imports are gone; smoke test green with the new assertions; README/PLAN describe the agent-driven flow.
- Committed and pushed to `git@github.com:Mattschoe/pi-extensions.git`.
- User can `/reload` and get a meaningful context file (agent-researched, with questions) in SmartHome.
