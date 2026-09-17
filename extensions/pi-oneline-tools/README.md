# pi-oneline-tools

## What it does
A [Pi](https://pi.dev/) extension that renders `read`, `grep`, `find`, `ls` and `bash` as one dim
line each instead of a bordered box. Consecutive calls of the same tool are grouped without blank
lines; switching to a different tool keeps one blank separator.

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
read src/config.ts (84 lines)
read src/types.ts (31 lines)

grep "ConfigSchema" (12 matches)

ls src (23 entries)

npm test -- --watch=false... (140 lines)
```

Press `ctrl+o` to expand the rows and see the original, uncollapsed, UI.

The compact bash override also exposes an optional `reason` argument for compatibility with
`@mattschoe/pi-plan` 1.1.0 and newer. Pi Plan uses it only when a command needs user approval, so
ordinary auto-approved commands remain unchanged.

## Conflicts

This extension works by **re-registering the built-in tool definitions** with `renderShell: "self"`
and its own `renderCall` / `renderResult`. Any other extension that overrides those same five tools
(`pi-tool-display` for example) will conflict, and whichever loads last wins. Pi Plan is explicitly
compatible because it preserves bash overrides that already expose the optional `reason` field.

## Examples
<img width="709" height="525" alt="image" src="https://github.com/user-attachments/assets/fb902fec-e734-4001-9690-5053521add4a" />
