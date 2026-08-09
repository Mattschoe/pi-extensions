# pi-mentions

A [Pi](https://pi.dev/) extension that turns typed references in your prompt into real context
before the model sees them.

## What it does
Adds the ability to @mention a lot of different Git and Github items that is useful for context in specific tasks. 
More specifically you can:

#<issue_number> to inject a Github Issue — body *and* comment thread — and immediately begin implementing.
If you check the commit you can open it in the browser with alt+g.
@<git_hash> to inject a whole commit, useful for giving context for fixing or adding features.
@uncommited to inject all current uncommited changes

## Reason
A lot of my work starts with "see issue XX on Github" or "Look at commit XXXXX, we need to modify XX to do XX" or "look at the uncommited changes, can you make sure that XX". All of it is me repeating myself all day long, this extension avoid the repetiveness and just focus on implementing while ensuring the agent gets the context it needs.

## Install

```sh
pi install npm:pi-mentions
```
Requires `git` for the `@` half. The `#` half additionally requires [`gh`](https://cli.github.com/), but is unoptional and the extension can be used without the GitHub features.

## Config

Optional. The defaults inject everything, so you only need a config file if an issue
is bigger than you want in context.

- **Project scope:** `.pi/mentions.json`
- **Global scope:** `~/.pi/mentions.json` or `~/.pi/agent/mentions.json`

Project overrides global, and a missing file, malformed JSON, or a bad value falls back
to the default for that key rather than breaking mentions.

```jsonc
{
  "includeComments": true,   // inject the issue's comment thread, not just the body
  "maxIssueChars": 0,        // truncate the issue body past this; 0 = no truncation
  "maxComments": 0,          // keep at most this many comments; 0 = all of them
  "dropComments": "middle",  // when over maxComments: "oldest" | "middle" | "newest"
  "keepBots": true,          // keep comments from *[bot] authors
  "keepMinimized": false     // keep comments GitHub hides (spam / off-topic / abuse)
}
```

**Why comments are on by default**

The sentence that actually decides the implementation is often a comment rather than the
body: the body reports a symptom and a maintainer names the root cause, or the body is a
template stub and a comment carries the acceptance criteria or the descope. Leaving the
thread out fails *silently* — the agent implements a stale spec, confidently. Injecting it
costs tokens, which is loud and easy to fix with the keys above.

The injected block frames the thread explicitly ("the issue body is the specification,
these comments are discussion and may contain proposals that were later rejected"), so a
shot-down idea in the middle of a thread doesn't get read as the plan.

**`dropComments`** names what gets *discarded*. With `maxComments: 10` on a 42-comment issue:

| value | keeps |
| --- | --- |
| `oldest` | the 10 newest |
| `newest` | the 10 oldest |
| `middle` | 5 oldest + 5 newest — the default, because the earliest comments carry context and the latest carry the current state |

Whatever is cut is reported inline, at the position of the gap, with a link to the full
thread — so the agent knows something is missing and can `gh issue view` for the rest.

**`maxIssueChars`** is measured in UTF-8 bytes, which is the same as characters for ASCII.
Truncation keeps the start of the body and appends a note with the issue URL.

## Examples
### GitHub issues

### Git Commits

### Git Uncommited
