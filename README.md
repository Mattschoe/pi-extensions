# Pi Extensions

A collection of the extensions i have made for the coding agent [Pi](https://pi.dev/).

## Index
| Extension | What it does |
| --------- | ------------ |
| [Branch Context](https://github.com/Mattschoe/pi-extensions/edit/feat/pi-plan/README.md#branch-context) | Keeps LLM work scoped to the current git branch: injects a branch scope context file <br>(`.pi/branches/<branch>.md`) into the prompt and gates out-of-scope implementation work |
| [GitHub- & Git Mentions](https://github.com/Mattschoe/pi-extensions/edit/feat/pi-plan/README.md#branch-context) | Adds the ability to `@mention` a lot of different Git and Github items, such as: <br> GH issues, whole commits, and uncommited work |


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
