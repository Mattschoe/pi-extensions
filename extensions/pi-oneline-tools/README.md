# pi-oneline-tools

## What it does
A [Pi](https://pi.dev/) extension that renders `read`, `grep`, `find`, `ls` and `bash` as one dim
line each instead of a bordered box.

## Reason
Its incredibly annoying to see so much popup in the TUI when the agent is just reading files, 
this removes clutter and makes it easier to focus on writes.

## Install
```sh
pi install npm:pi-oneline-tools
```

## What it looks like
**Before:**
```
┌─ read ────────────────────────────────────────────────┐
│ /home/you/project/src/config.ts                       │
│                                                       │
│   1  import { z } from "zod";                         │
│   2                                                   │
│   3  export const ConfigSchema = z.object({           │
│   …                                                   │
└───────────────────────────────────────────────────────┘
```

**After:**
```
read ~/project/src/config.ts (84 lines)
grep "ConfigSchema" (12 matches)
ls ~/project/src (23 entries)
npm test -- --watch=false... (140 lines)
```

Press `ctrl+o` to expand the rows and see the original, uncollapsed, UI.

## Conflicts

This extension works by **re-registering the built-in tool definitions** with `renderShell: "self"`
and its own `renderCall` / `renderResult`. Any other extension that overrides those same five tools
(`pi-tool-display` for example) will conflict, and whichever loads last wins.

## Examples
<img width="709" height="525" alt="image" src="https://github.com/user-attachments/assets/fb902fec-e734-4001-9690-5053521add4a" />
