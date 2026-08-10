# Pi Extensions

A collection of the extensions i have made for the coding agent [Pi](https://pi.dev/).

## Index
| Extension | What it does |
| --------- | ------------ |
| [Branch Context](#branch-context) | Keeps LLM work scoped to the current git branch: injects a branch scope context file <br>(`.pi/branches/<branch>.md`) into the prompt and gates out-of-scope implementation work |
| [GitHub- & Git Mentions](#github---git-mentions) | Adds the ability to `@mention` a lot of different Git and Github items, such as: <br> GH issues, whole commits, and uncommited work |
| [Plan & Auto-accept Mode](#plan--auto-accept-mode) | A classic planning & auto-accept mode you know and love from Claude Code. <br> This is however with a bunch of extra features added on top, features such as: <br> - Improved plan document structure <br> - `Implement in new chat` option <br> - Proper naming of plan files <br> - `/plans` browser <br> - Visual Execution Tracking (TODO boxes) | 
| [Oneline Tools](#oneline-tools) | Renders `read`, `grep`, `find`, `ls`, `bash` as one dim line instead of a bordered box |

## Packages

### [Branch Context](extensions/branch-context/)

#### What it does
Keeps LLM work scoped to the current git branch: injects a branch scope context file (`.pi/branches/<branch>.md`) into the prompt and gates out-of-scope implementation work behind a blocking "implement here / separate branch" user choice dialog.

#### Reason
I often found myself constantly having to explain to the agent what this branch was about and the commits so far on the branch whenever i wanted it to work on a branch. This extension prevents the repetitiveness of writing context, and i can therefore focus on explaining the feature of fix i need help with.  

### [GitHub- & Git Mentions](extensions/pi-mentions/)

#### What it does
Adds the ability to `@mention` a lot of different Git and Github items that is useful for context in specific tasks.
More specifically you can
- `#<issue_number>` to inject a Github Issue and immediately begin implementing. 
  If you check the commit you can open it in the browser with `alt+g`.
- `@<git_hash>` to inject a whole commit, useful for giving context for fixing or adding features.
- `@uncommited` to inject all current uncommited changes

#### Reason
A lot of my work starts with "see issue XX on Github" or "Look at commit XXXXX, we need to modify XX to do XX" or
"look at the uncommited changes, can you make sure that XX". All of it is me repeating myself all day long,
this extension avoid the repetiveness and just focus on implementing while ensuring the agent gets the context it needs.

### [Plan & Auto-accept Mode](extensions/pi-plan/)
#### What it does
A classic planning & auto-accept mode you know and love from Claude Code. This is however with a bunch
of extra features added on top, features such as:
- **Improved plan document structure:** Plans get build as a plan, not a logbook of discussion. 
  They also include the context (WHY & files to read) necessary for a fresh implementation-agent
  to implement the plan
- **`Implement in new chat`:** You don't always want the same LLM session to both plan and execute,
  this extension adds an additional button to implement in a fresh chat when a plan has been written.
- **`/plans` browser:** A simple plan browser so you can easily reference your plans
- **Proper naming of plans:** Plans are named relatively to what the plan is, and not just random words
  (why did you think that was a good idea Claude Code)
- **Execution tracking:** The simple TODO execution tracker you know and love from Claude Code

#### Reason
I kept noticing my plans were turning into logbooks of the back-and-forth I had with the agent instead of
an actual plan, and by the time a plan was done I'd have 100k+ tokens of reading and brainstorming in the
session I definitely didn't want an implementer chewing through. This extension keeps plans as clean,
readable snapshots and lets me hand them off to a fresh chat instead of dragging that context along.

Fun fact: The ability to customize a planning mode to my liking is like 90% of why i changed to Pi
over Claude Code

### [Oneline Tools](extensions/pi-oneline-tools/)
#### What it does
Renders `read`, `grep`, `find`, `ls` and `bash` as one dim line each instead of a bordered box.

#### Reason
Its incredibly annoying to see so much popup in the TUI when the agent is just reading files, 
this removes clutter and makes it easier to focus on writes.
