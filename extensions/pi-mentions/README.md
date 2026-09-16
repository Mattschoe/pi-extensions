# pi-mentions

A [Pi](https://pi.dev/) extension that turns typed references in your prompt into real context
before the model sees them.

## What it does
Adds the ability to `@mention` a lot of different Git and Github items that is useful for context in specific tasks.
More specifically you can
- `#<number>` to inject a GitHub issue or pull request. Use `alt+g` to open the selected or referenced
  item in the browser. **Issue references** inject the body and comment thread. ****Pull request references** inject the title,
  body, metadata, general comments, review summaries, inline review conversations, and a bounded
  changed-file summary. Patches and complete source files are deliberately left out; the agent can
  inspect them through its existing Git and GitHub capabilities when the surrounding request needs
  them. Large semantic PRs are summarized by changed area and churn, while rename-heavy PRs show
  grouped and representative renames rather than dumping every path.
- GitHub Actions runs also appear under `#`, always below issue and pull request matches. The latest
  run across all branches for every active workflow is shown, newest workflow run first. Its status
  occupies the people column (`[Success]`, `[Failure]`, `[Running]`, etc.) with only the status text
  semantically colored, while its branch is right-aligned in the Project column. Workflow names and
  YAML paths are searchable. Active workflows that have never run and disabled workflows are
  omitted.

  The referenced run injects metadata plus job and step conclusions. Diagnostic failures also
  inject failed-step logs, preserving the head and tail under a configurable 100 KB default cap.
  The context includes exact `gh run view` commands for obtaining complete run or job logs. Expired
  or unavailable logs do not discard the remaining run metadata. Workflow results are cached for
  30 seconds; stale rows display immediately while one background refresh prepares the next popup.
  `alt+g` opens the exact Actions run just as it opens issues and pull requests.
- `@<git_hash>` to inject a whole commit, useful for giving context for fixing or adding features.
- `@uncommited` to inject all current uncommited changes

## Reason
A lot of my work starts with "see issue XX on Github" or "Look at commit XXXXX, we need to modify XX to do XX" or
"look at the uncommited changes, can you make sure that XX". All of it is me repeating myself all day long,
this extension avoid the repetiveness and just focus on implementing while ensuring the agent gets the context it needs.

## Install

```sh
pi install npm:pi-mentions
```
Requires `git` for the `@` half. The `#` half additionally requires [`gh`](https://cli.github.com/),
but it is optional and the extension can be used without the GitHub features.

## Config

Optional. The defaults inject every issue/PR conversation, so you only need a config file if a
GitHub item is bigger than you want in context.

- **Project scope:** `.pi/mentions.json`
- **Global scope:** `~/.pi/mentions.json` or `~/.pi/agent/mentions.json`

The default looks like so:
```jsonc
{
  "includeComments": true,   // inject issue comments and PR conversations/reviews
  "maxIssueChars": 0,        // truncate an issue or PR body past this; 0 = no truncation
  "maxComments": 0,          // keep at most this many entries per conversation/thread; 0 = all
  "dropComments": "middle",  // when over maxComments: "oldest" | "middle" | "newest"
  "keepBots": true,          // keep comments from *[bot] authors
  "keepMinimized": false,    // keep comments GitHub hides (spam / off-topic / abuse)
  "maxWorkflowLogBytes": 100000 // failed-step logs per Actions run; 0 = no cap
}
```

## Examples
### GitHub issues
<img width="944" height="118" alt="590a98b5-4efe-4a88-bfa2-a7166304c361" src="https://github.com/user-attachments/assets/73f2d2a2-d495-49c4-9782-43bd0cea302f" />

### GitHub Pull-Requests
<img width="937" height="143" alt="705e24a5-c3c4-447b-8a4b-0243c151d27e" src="https://github.com/user-attachments/assets/76324dd9-1f38-4e86-a6cf-f547a3cc162b" />

### GitHub Actions
<img width="944" height="149" alt="fc8bbfd8-08b5-4119-92e1-9a1ac32b74f5" src="https://github.com/user-attachments/assets/0bce07d9-9be0-4ad9-8b84-63d9a4ffde54" />

### Git Commits
<img width="1836" height="639" alt="image" src="https://github.com/user-attachments/assets/2b2af1a8-a349-4ed7-9352-ddd325cb4812" />

### Git Uncommited
<img width="1228" height="291" alt="image" src="https://github.com/user-attachments/assets/6f9f2f39-7b4d-4793-b8fa-627320c432cd" />
