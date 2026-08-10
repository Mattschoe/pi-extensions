// Smoke test for pi-oneline-tools.
//
// Loads the extension through jiti with pi's aliases, collects the tool
// definitions it registers, and drives their renderers directly. No real pi
// instance required.
//
// Small on purpose: this is a rendering wrapper, and the only behaviour worth
// pinning is that a collapsed row is exactly one line and an expanded one
// carries the tool's full output. The expanded path is easy to get wrong — the
// builtin tool definitions have no `renderResult` to delegate to, so an
// expanded row that delegates renders nothing at all.
//
// Run: node test/smoke.mjs   (from the package dir)
//      PI_DIR=/path/to/pi-coding-agent node test/smoke.mjs

import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const PI_DIR =
  process.env.PI_DIR ?? "/home/matt/.local/lib/node_modules/@earendil-works/pi-coding-agent";
const HERE = dirname(new URL(import.meta.url).pathname);
const EXT_FILE = join(HERE, "..", "extensions", "index.ts");

const piRequire = createRequire(join(PI_DIR, "package.json"));
const jitiStaticFile = join(PI_DIR, "node_modules", "jiti", "lib", "jiti-static.mjs");
const { createJiti } = await import(pathToFileURL(jitiStaticFile).href);

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(PI_DIR, "dist", "index.js"),
    "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
  },
});

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The renderers only ever call theme.fg, so identity is a faithful stand-in and
// keeps assertions on plain strings rather than escape codes.
const theme = { fg: (_style, text) => text, bold: (t) => t };
const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], isError });
const render = (component) => component.render(200).map((l) => l.trimEnd());

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

console.log("\n== load ==");
const factory = await jiti.import(EXT_FILE, { default: true });
check("default export is a function", typeof factory === "function");

const tools = new Map();
factory({ registerTool: (def) => tools.set(def.name, def) });

check(
  "registers the five lookup tools",
  ["read", "grep", "find", "ls", "bash"].every((n) => tools.has(n)),
  [...tools.keys()].join(", "),
);
check(
  "every tool renders its own shell",
  [...tools.values()].every((t) => t.renderShell === "self"),
);
check(
  "every tool keeps the builtin execute",
  [...tools.values()].every((t) => typeof t.execute === "function"),
);

// ---------------------------------------------------------------------------
// Collapsed rows
// ---------------------------------------------------------------------------

console.log("\n== collapsed ==");
const read = tools.get("read");
const threeLines = textResult("l1\nl2\nl3");

const readRow = render(read.renderResult(threeLines, { expanded: false }, theme, {
  args: { path: join(process.env.HOME ?? "/home", "project/src/config.ts") },
}));
check("a collapsed row is one line", readRow.length === 1, JSON.stringify(readRow));
check("home is shortened to ~", readRow[0].startsWith("read ~/project/src/config.ts"), readRow[0]);
check("with the line count", readRow[0].endsWith("(3 lines)"), readRow[0]);

const relative = render(read.renderResult(threeLines, { expanded: false }, theme, {
  args: { path: "src/config.ts" },
}));
check("a relative path is absolutised", relative[0].includes("/src/config.ts"), relative[0]);

const grepRow = render(
  tools.get("grep").renderResult(threeLines, { expanded: false }, theme, {
    args: { pattern: "ConfigSchema" },
  }),
);
check("grep counts matches", grepRow[0] === 'grep "ConfigSchema" (3 matches)', grepRow[0]);

const lsRow = render(
  tools.get("ls").renderResult(threeLines, { expanded: false }, theme, { args: { path: "/etc" } }),
);
check("ls counts entries", lsRow[0] === "ls /etc (3 entries)", lsRow[0]);

const findRow = render(
  tools.get("find").renderResult(threeLines, { expanded: false }, theme, {
    args: { pattern: "*.ts" },
  }),
);
check("find counts matches", findRow[0] === 'find "*.ts" (3 matches)', findRow[0]);

const longCommand = "npm run test -- --reporter=verbose --watch=false --coverage\nsecond line";
const bashRow = render(
  tools.get("bash").renderResult(threeLines, { expanded: false }, theme, {
    args: { command: longCommand },
  }),
);
check("bash shows only the first line of the command", !bashRow[0].includes("second line"));
check("truncated to 35 characters", bashRow[0].startsWith("npm run test -- --reporter=verbo..."), bashRow[0]);
check("with the line count", bashRow[0].endsWith("(3 lines)"), bashRow[0]);

const missingArgs = render(read.renderResult(threeLines, { expanded: false }, theme, {}));
check("a missing arg degrades to a placeholder", missingArgs.length === 1 && missingArgs[0].includes("?"));

const errorRow = render(
  read.renderResult(textResult("ENOENT", true), { expanded: false }, theme, {
    args: { path: "/nope.ts" },
  }),
);
check("an error row is still one line", errorRow.length === 1);
check("and says error", errorRow[0] === "read /nope.ts — error (1 lines)", errorRow[0]);

// ---------------------------------------------------------------------------
// Expanded rows — the regression this test exists for
// ---------------------------------------------------------------------------

console.log("\n== expanded ==");
const expanded = render(
  read.renderResult(threeLines, { expanded: true }, theme, { args: { path: "/tmp/x.ts" } }),
);
check("an expanded row is not empty", expanded.length > 0, JSON.stringify(expanded));
check("it keeps the summary line first", expanded[0] === "read /tmp/x.ts (3 lines)", expanded[0]);
check(
  "and carries the full output underneath",
  expanded.slice(1).join("\n") === "l1\nl2\nl3",
  JSON.stringify(expanded),
);

const expandedError = render(
  read.renderResult(textResult("ENOENT: no such file", true), { expanded: true }, theme, {
    args: { path: "/nope.ts" },
  }),
);
check(
  "an expanded error carries its message",
  expandedError.join("\n").includes("ENOENT: no such file"),
  JSON.stringify(expandedError),
);

const empty = render(
  read.renderResult({ content: [], isError: false }, { expanded: true }, theme, {
    args: { path: "/tmp/x.ts" },
  }),
);
check("an empty result expands to just the summary", empty.length === 1, JSON.stringify(empty));

// ---------------------------------------------------------------------------
// Call rows
// ---------------------------------------------------------------------------

console.log("\n== call ==");
const call = render(read.renderCall({ path: "/tmp/x.ts" }, theme, {}));
check("the in-flight row is one line", call.length === 1);
check("ending in an ellipsis", call[0] === "read /tmp/x.ts...", call[0]);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("Failures:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("SMOKE TEST OK");
