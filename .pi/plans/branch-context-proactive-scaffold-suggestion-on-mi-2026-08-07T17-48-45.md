---
created: "2026-08-07T17:48:45.299Z"
mode: "plan"
session: "/home/matt/.pi/agent/sessions/--home-matt-Projects-pi-extensions--/2026-08-07T17-35-26-110Z_019fdd4b-479d-74f5-a529-a71d6b7328f5.jsonl"
---

I have everything verified. Here's the plan.

# branch-context: proactive scaffold suggestion on missing context file

## Context

The user tested the branch-context extension on a fresh branch (`refactor/redesign-frontpage` in `personal-website`) with "Lets build something cool!". The one-time notice fired correctly, but the agent — seeing "Run /branch-scaffold…" with no further guidance — wasted tokens reading extension source (`~/.pi/agent/extensions/branch-context.ts`, 685 lines) and pi internals trying to reverse-engineer what to do.

Two changes requested:
1. When no context file exists, the agent must be told (via prompt injection) to **proactively offer** creating it — e.g. "I noticed there's no branch-context file for this branch yet — want me to create one?" — and on "yes" create it, instead of fumbling.
2. This injection must be a **config option** (default `true`), while the existing user-facing notice line ("Run /branch-scaffold to have the agent write one…") stays byte-identical.

**Mechanism decision (verified against pi 0.83 dist):** pi has **no model→slash-command dispatch**. `sendUserMessage` calls `prompt(text, { expandPromptTemplates: false })`, which skips command handling (agent-session.js `prompt()`); `steer()`/`followUp()` throw on extension commands; the agent's tool set (bash/read/write/edit/grep/find/ls + registered tools) has no command tool. So "on yes it will run /branch-scaffold" is implemented as: the **model performs the scaffold itself** (git research via bash, then write the file), guided by the same spec the command steers with, embedded in the injected message. User-visible outcome is identical (offer → yes → file written, `generated: true`). `/branch-scaffold` remains for manual use, untouched.

**Guidance placement decision:** the guidance lives in the **notice message `content`** (persisted as a `custom_message` session entry, so it reaches the LLM on every prompt and survives resume — `details` is renderer metadata and must not be relied on). Tradeoff: the user also sees the guidance block in the `[branch-context]` bubble, below the unchanged notice line. This is accepted (consistent with the existing long injected blocks). A `systemPrompt`-only variant would hide it from the user but loses resume persistence — rejected.

## Files to Read

1. `/home/matt/Projects/pi-extensions/extensions/branch-context/extensions/index.ts` — config block (`Config`/`DEFAULT_CONFIG`/`applyConfigFile`, ~lines 60–150), the missing-file branch in `before_agent_start` (~lines 555–575), the `/branch-scaffold` command (~lines 640–684) whose prompt text is the source of the spec.
2. `/home/matt/Projects/pi-extensions/extensions/branch-context/test/smoke.mjs` — the "missing context file" section (~lines 330–350), the every-turn config section (~lines 360–415, it overwrites `.pi/branch-context.json` — ordering matters for the new test block), and the `check`/`hasSubstring` helpers.
3. `/home/matt/Projects/pi-extensions/extensions/branch-context/README.md` — config JSONC block + "Behavior details" bullets.
4. `/home/matt/Projects/pi-extensions/extensions/branch-context/PLAN.md` — config list, "No: one-time notice" bullet (~line 103), "Done when" (~line 194).

(Optional re-verification of pi facts: `dist/core/extensions/types.d.ts` `BeforeAgentStartEventResult` = `{ message?, systemPrompt? }` with chained systemPrompt; `dist/core/agent-session.js` `prompt()`/`sendUserMessage` behavior as described above.)

## Files to Modify

- `extensions/branch-context/extensions/index.ts`
- `extensions/branch-context/test/smoke.mjs`
- `extensions/branch-context/README.md`
- `extensions/branch-context/PLAN.md`

## Files to Create

None.

## Plan

1. **Add `suggestScaffold` to config.** In `Config` interface, `DEFAULT_CONFIG`, and `applyConfigFile`: `suggestScaffold: boolean`, default `true`, parsed with `if (typeof obj.suggestScaffold === "boolean") merged.suggestScaffold = obj.suggestScaffold;`. Update the header-comment config list (`{ "enabled": true, "inject": ..., "maxWords": 300, "excludeBranches": [...], "pruneOnStart": true, "staleThresholdCommits": 20, "suggestScaffold": true }`).

2. **Extract a shared structure template** so the command prompt and the guidance never drift. Module const:
   ```ts
   const SCAFFOLD_TEMPLATE = (branch: string, today: string, tip: string) =>
     `---\nbranch: ${branch}\nwritten_at: ${today}\ntip: ${tip}\ngenerated: true\n---\n\n` +
     `WHAT THIS BRANCH IS ABOUT:\n<concise statement of this branch's purpose and scope>\n\n` +
     `WHAT THIS BRANCH IS NOT ABOUT:\n<what is deliberately out of scope — other areas/features this branch does NOT touch>`;
   ```
   Refactor the `/branch-scaffold` command prompt to emit **byte-identical output**: `Write "${relFile}" in this repo with EXACTLY this structure:\n\`\`\`\n${SCAFFOLD_TEMPLATE(branch, today, tip)}\n\`\`\`` (keep the fence; keep the rest of the command prompt and the notify + `pi.sendUserMessage` handoff exactly as-is). All existing command smoke assertions ("feature/auth", `.pi/branches/feature/auth.md`, "WHAT THIS BRANCH IS ABOUT", "generated: true", "ASK the user questions") must stay green.

3. **Add `buildScaffoldGuidance(pi, repo, branch, relFile): Promise<string>`** (module-level, next to `findBase`/`shortHead`): compute `base = await findBase(pi, repo)`, `tip = await shortHead(pi, repo)`, `today = new Date().toISOString().slice(0, 10)`, `logCmd = base ? \`git log --oneline ${base}..HEAD\` : "git log --oneline -20"`, `diffCmd = base ? \`git diff --stat ${base}...HEAD\` : "git diff --stat HEAD~10...HEAD"` (same fallbacks as the command). Return the guidance block (exact text below; marker phrases are asserted by tests — keep them verbatim; escape backticks in the TS string like the command prompt does):
   ```
   [agent guidance — offer to create the branch-context file]
   Whenever the user starts work on this branch, briefly suggest creating the context file before writing code — e.g. "I noticed there's no branch-context file for this branch yet — want me to create one?"
   Do NOT read the branch-context extension source or search for how this file should look — everything you need is described here.
   If the user agrees, write "<relFile>" yourself with EXACTLY this structure:
   <SCAFFOLD_TEMPLATE(branch, today, tip)>
   How to write it well:
   1. Study the branch: the branch name, `<logCmd>` (or the last 20 commits of HEAD when no base exists), and `<diffCmd>` (base = merge-base of HEAD with main/origin/main, or HEAD~10 when no main exists). If the branch has no commits beyond base, ask the user what it is about.
   2. Infer the branch's intent from the name, commits, and diff. If anything is genuinely ambiguous, ASK the user questions first — do not guess. If the intent is already clear (branch name or the user's request), write the file without extra questions.
   3. Synthesize intent; do NOT paste the commit log or diff stat verbatim. Keep it concise (a few sentences per section, well under 300 words).
   4. After writing, tell the user what you wrote and remind them to review it for secrets (it is generated from git history).
   ```

4. **Modify the missing-file branch in `before_agent_start`** (~line 555). Keep the guard/keys/dedupe (`noticedMissing` + `sessionHasContextMessage`) and the `display: true` return exactly as today. Change:
   - `const userLine = \`No branch-context file exists for branch "${branch}". Run /branch-scaffold to have the agent write one, or create ${relFile} yourself.\`;`
   - `const content = config.suggestScaffold ? \`${userLine}\n\n${await buildScaffoldGuidance(pi, repo, branch, relFile)}\` : userLine;`
   - `details: { repo, branch, missing: true, suggestScaffold: config.suggestScaffold }`.
   When `suggestScaffold` is false, content is byte-identical to today's text.

5. **Extend `test/smoke.mjs`** — fake pi needs no changes (no new api surface; `sendUserMessage` already exists for the command tests). In the existing "missing context file" section (feature/notes, default config → `suggestScaffold: true`):
   - Keep the existing three checks (`/branch-scaffold` in content, `details.missing === true`, no-repeat second call).
   - Add: content contains `"want me to create one"`, `"generated: true"`, `"WHAT THIS BRANCH IS ABOUT"`, `"ASK the user questions"`, and `"Do NOT read the branch-context extension"`.
   - Add a new block right after (still before the every-turn section, which later overwrites `.pi/branch-context.json`): write `.pi/branch-context.json` with `{"suggestScaffold": false}`, create a fresh branch (e.g. `feature/no-suggest` + one commit), `sessionStart` (resets `noticedMissing`), run `before_agent_start` → assert content still contains `"/branch-scaffold"` but **not** `"want me to create one"`; second call → no repeat. Then restore: delete `.pi/branch-context.json` (or rewrite it) and `git checkout feature/auth` + delete the `feature/no-suggest` branch.

6. **Update docs.**
   - `README.md`: config JSONC adds `"suggestScaffold": true, // when no context file exists, have the agent proactively offer to create one` plus a bullet explaining it; "Missing context file" behavior bullet becomes: "one notice per session per branch offering `/branch-scaffold`; never nags again. The notice text is always shown; with `suggestScaffold: true` (default) it also carries agent guidance to proactively offer creating the file and, on agreement, write it itself (same spec as `/branch-scaffold`) — set it to `false` for the plain notice only."
   - `PLAN.md`: add `suggestScaffold` to the config block, update the "No: one-time notice" bullet, and add both config paths to "Done when".

7. **Run `node test/smoke.mjs`** from `extensions/branch-context/` — expect all green (~60 checks; count grows from 54).

8. **Commit + push** (`cd /home/matt/Projects/pi-extensions && git add -A && git commit && git push`). No `~/.pi` changes (symlink target unchanged) → **no pi-backup needed**. Then tell the user to `/reload` and try a fresh branch chat.

## Risks

- **"Runs /branch-scaffold" is not literal**: pi has no model→command dispatch, so the agent writes the file itself guided by the injected spec. Outcome identical; the command still works for manual use. State this to the user.
- **Guidance is visible in the message bubble** (lives in `content`, which is displayed). Accepted tradeoff for persistence across resume; alternative (systemPrompt-only) hides it but doesn't persist.
- **Spec drift** between the command prompt and the guidance — mitigated by the shared `SCAFFOLD_TEMPLATE` const (steps 2–3).
- **Two extra git spawns** (`findBase`, `shortHead`) on the notice turn — one-time per session per branch, fast local commands.
- **Model non-compliance**: a weak model may still not offer or may still read files; guidance is explicit ("Do NOT read the branch-context extension source"), and behavior with `suggestScaffold: false` is unchanged from today.
- **Empty branches** (no commits beyond base): guidance explicitly tells the model to ask what the branch is about — matches the user's reported case.

## Testing Strategy

- Smoke test re-run green with the new assertions: notice carries the guidance markers under default config; `suggestScaffold: false` yields the plain notice; dedupe and all existing sections unaffected.
- User-level check (SmartHome or personal-website, fresh branch): `/reload`, "Lets build something cool!" → agent's first reply offers to create the context file (no extension-source reading); on "yes" it writes `.pi/branches/<branch>.md` with `generated: true` and reports; with `suggestScaffold: false` in config, the plain notice appears and no offer is made.

## Done When

- `suggestScaffold` (default `true`) is parsed from config; the missing-file notice keeps its exact user-facing line in both modes; guidance is injected only when `suggestScaffold` is true.
- Guidance tells the agent to offer, forbids reading extension sources, embeds the real branch/relFile/tip/base commands, and carries the exact structure template (shared with the command via one const).
- Smoke test green with the new assertions; README/PLAN updated; committed and pushed to `git@github.com:Mattschoe/pi-extensions.git`; no `~/.pi` changes.
- After `/reload`, a fresh branch chat shows the agent proactively offering to create the context file and writing it on agreement — no wasted file-reading detour.
