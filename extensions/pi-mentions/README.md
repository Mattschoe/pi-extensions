# pi-mentions

A [Pi](https://pi.dev/) extension that turns typed references in your prompt into real context
before the model sees them.

## What it does
Adds the ability to `@mention` a lot of different Git and Github items that is useful for context in specific tasks.
More specifically you can
- `#<issue_number>` to inject a Github Issue and immediately begin implementing. 
  If you check the commit you can open it in the browser with `alt+g`.
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
but is unoptional and the extension can be used without the GitHub features.

## Config

Optional. The defaults inject everything, so you only need a config file if an issue
is bigger than you want in context.

- **Project scope:** `.pi/mentions.json`
- **Global scope:** `~/.pi/mentions.json` or `~/.pi/agent/mentions.json`

The default looks like so:
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

## Examples
### GitHub issues
<img width="454" height="126" alt="image" src="https://github.com/user-attachments/assets/31abd260-6384-434c-9b66-8db76025b441" />

<img width="1623" height="262" alt="image" src="https://github.com/user-attachments/assets/9473aca5-9736-4b72-aea0-a8a90a2b9407" />

### Git Commits
<img width="1836" height="639" alt="image" src="https://github.com/user-attachments/assets/2b2af1a8-a349-4ed7-9352-ddd325cb4812" />


### Git Uncommited
<img width="1228" height="291" alt="image" src="https://github.com/user-attachments/assets/6f9f2f39-7b4d-4793-b8fa-627320c432cd" />

