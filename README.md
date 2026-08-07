# pi-extensions

A collection of extensions for the coding agent [Pi](https://pi.dev/).

## Packages

| Package | What it does |
| --- | --- |
| [`extensions/branch-context`](extensions/branch-context/) — **pi-branch-context** | Keeps LLM work scoped to the current git branch: injects a branch scope context file (`.pi/branches/<branch>.md`) into the prompt and gates out-of-scope implementation work behind a blocking "implement here / separate branch" user choice dialog. |

## Development

Each package under `extensions/` is a standalone pi package (own `package.json` with a `pi`
manifest entry). Local install for testing: symlink the package's extension file into
`~/.pi/agent/extensions/` and `/reload` pi. Publishing: `npm publish` from the package dir.
