# Pi Extensions

A collection of the extensions i have made for the coding agent [Pi](https://pi.dev/).

## Packages

### [Branch Context](extensions/branch-context/)

**What it does:**
Keeps LLM work scoped to the current git branch: injects a branch scope context file (`.pi/branches/<branch>.md`) into the prompt and gates out-of-scope implementation work behind a blocking "implement here / separate branch" user choice dialog.

**Reason:**
I often found myself constantly having to explain to the agent what this branch was about and the commits so far on the branch whenever i wanted it to work on a branch. This extension prevents the repetitiveness of writing context, and i can therefore focus on explaining the feature of fix i need help with.  
