# @mattschoe/pi-plan

A [Pi](https://pi.dev/) extension that adds a plan mode, an accept-edits mode, and execution
tracking for the plans it produces.

This is a fork of [`pi-pledit@1.0.1`](https://www.npmjs.com/package/pi-pledit) by **jaroslawjanas**, 
which implemented the planning & accept-edits modes inspired from Claude Code. 
This extension extends jaroslawjanas' work with the following new features.

## New features

### Improved plan document structure
When writing plans with agents like Claude Code or OpenAI you very often find yourself seeing that the
plan is a "logbook" of the conversation and disagreements you had with the LLM before the plan is written.
Often i found it concluded information such as "as we agreed, we do XX and not YY" or "do XX since you
thought that made more sense" or "XX because YY ended up not being realistic". While this is good 
information in my opinion Agentic plans shouldn't be a logbook of decisions, it should instead
be a snapshot of a idea, or well, a plan. So this plan mode instead focuses on what a plan should contain
information such as:
- Why are we doing this? (context)
- What files to read? (prevents loose discovery)

This has the added benefit of being much much cleaner to have a seperate implementation-agent 
running and implementing the plan. Very often you want to use a big reasoning model for planning,
while a smaller model can be responsible for implementing. This planning structure helps the smaller
model stay focused on what needs to be read, and what needs to be implemented. 


### Handoff to a fresh chat
When building plans i often reach >100k tokens. That's 100k tokens of file reading, verification,
planning/brainstorming back and forths. It is not a context window i want my implementer of the plan
to use. This plan therefore introduces a fourth option when a plan has been written "implement in
new chat". 

Fun fact: This single feature is 90% of the reason why i changed to Pi from Claude Code. I have spent
so much time opening my file viewer, finding the plan in claudes `plans/` folder and dumping it in a 
fresh session.

### `/plans` browser.
A simple plans viewer that shows the plans generated. Oh and plans are actually named something
related to the plan, and not just random words (why did you think that was a good idea Claude Code).

### Execution tracking
A simple TODO execution tracker, much like Claude Code's 

## Install
```sh
pi install npm:@mattschoe/pi-plan
```

## Modes

Since the upstream to `pi-pledit` is gone, here's some light documentation for how it works:

Press the shortcut (`f6` by default, see [Config](#config)) to cycle:

| Mode | Status | Behaviour |
|---|---|---|
| Default | *(none)* | Prompts before every `write`/`edit` and before any non-read-only `bash`. |
| Accept edits | `⏵⏵ accept edits` | Auto-approves everything except commands matching `unsafePatterns`. |
| Plan | `∥∥ plan mode` | `write`/`edit` blocked; `bash` limited to the `readonlyBash` allowlist. |

The mode is persisted to the session, so resuming a session resumes its mode.

`--plan` starts a session directly in plan mode.

## Commands

| Command | What it does |
|---|---|
| `/plans` | Browse `.pi/plans/`. `↑↓` navigate, `enter` inserts the path into the editor, `→` opens the plan in `$EDITOR`, `←`/`esc` closes. |
| `/execute-plan` | Same browser, but the selected plan is executed in a new session with tracking enabled. |
| `/plan-approve <path>` | Execute a specific plan file in a new chat. This is what option 4 prefills. |
| `/todos` | Print the current plan's steps and their state. |

`→` in the browser launches `$VISUAL`, then `$EDITOR`, falling back to `vi`. Editors that need
arguments work too (`EDITOR="code -w"`).

## Config
- **Project scope:** `.pi/pledit.json`
- **Global scope:** `~/.pi/agent/pledit.json`

The default looks like so:
```jsonc
{
  "shortcut": "f6",                // key that cycles modes; e.g. "shift+tab"
  "readonlyBash": ["ls ", "git status", "..."],
  "unsafePatterns": ["rm -rf", "sudo", "chmod 777", "docker system prune"]
}
```

### `readonlyBash`
Prefixes allowed in plan mode, and allowed silently in default mode. 

### `unsafePatterns`
Substrings that force a confirmation prompt even in accept-edits mode, and
that disqualify a command from the read-only allowlist. Matching happens after wrappers and leading
environment assignments are stripped, so `FOO=1 timeout 5 sudo rm -rf /` is matched on
`sudo rm -rf /`.

## Examples
### `/plans`
<img width="541" height="260" alt="image" src="https://github.com/user-attachments/assets/607cdd57-538c-4525-8353-dd3e09471d52" />

### Start plan in new chat
<img width="466" height="160" alt="image" src="https://github.com/user-attachments/assets/fe0d65e4-7b3c-40f8-ab09-37d96d9aa619" />


## License

MIT — see [LICENSE](./LICENSE). Copyright is held jointly by jaroslawjanas for the original
`pi-pledit` and by Matthias Schoenning Nielsen for the modifications.
