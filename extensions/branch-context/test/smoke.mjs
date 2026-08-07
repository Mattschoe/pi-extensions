// Smoke test for pi-branch-context.
//
// Loads the extension through jiti using the same alias mechanism pi's loader
// uses, then drives its event handlers against a scratch git repo (/tmp/bc-test)
// with a fake pi/ctx. No real pi instance required.
//
// Run: node test/smoke.mjs   (from the package dir)

import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const PI_DIR = "/home/matt/.local/lib/node_modules/@earendil-works/pi-coding-agent";
const HERE = dirname(new URL(import.meta.url).pathname);
const PKG_DIR = join(HERE, "..");
const EXT_FILE = join(PKG_DIR, "extensions", "index.ts");
const TEST_REPO = "/tmp/bc-test";
const REMOTE = "/tmp/bc-remote.git";

// ---------------------------------------------------------------------------
// Jiti loader with pi's aliases (subset: only what the extension imports)
// ---------------------------------------------------------------------------

const piRequire = createRequire(join(PI_DIR, "package.json"));
// jiti/static is only exported under the "import" condition, so require.resolve
// can't see it — resolve the physical file like the loader does.
const jitiStaticFile = join(PI_DIR, "node_modules", "jiti", "lib", "jiti-static.mjs");
const jitiMod = await import(pathToFileURL(jitiStaticFile).href);
const createJiti = jitiMod.createJiti;

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(PI_DIR, "dist", "index.js"),
    typebox: piRequire.resolve("typebox"),
  },
});

// ---------------------------------------------------------------------------
// Fake pi + ctx
// ---------------------------------------------------------------------------

function execGit(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 15000 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        killed: false,
      });
    });
  });
}

function makeFakePi() {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const sent = [];
  let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const api = {
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerCommand(name, opts) {
      commands.set(name, opts);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = [...names];
    },
    exec: (cmd, args, opts) => execGit(cmd, args, opts),
    sendUserMessage: (content, opts) => {
      sent.push(content);
    },
  };
  return {
    api,
    handlers,
    tools,
    commands,
    sent,
    activeTools: () => [...activeTools],
  };
}

function makeCtx(cwd, { trusted = true, entries = [], notifySink = [], selectResult, hasUI = false } = {}) {
  return {
    cwd,
    mode: hasUI ? "tui" : "print",
    hasUI,
    isProjectTrusted: () => trusted,
    ui: {
      notify: (msg) => notifySink.push(msg),
      select: async () => selectResult,
    },
    // Model the real runtime: extension command/event contexts do NOT carry
    // sendUserMessage (runner.createContext() lacks it) — only pi.* does.
    sessionManager: { getEntries: () => entries },
    getSystemPrompt: () => "",
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok - ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL - ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

function hasSubstring(haystack, needle) {
  return typeof haystack === "string" && haystack.includes(needle);
}

async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scratch repo setup
// ---------------------------------------------------------------------------

await rm(TEST_REPO, { recursive: true, force: true });
await rm(REMOTE, { recursive: true, force: true });
await mkdir(TEST_REPO, { recursive: true });

const git = (args, cwd = TEST_REPO) => execGit("git", args, { cwd });

await git(["init", "-b", "main"]);
await git(["config", "user.email", "t@t"]);
await git(["config", "user.name", "t"]);

async function commit(message) {
  await git(["add", "-A"]);
  await git(["commit", "-m", message]);
}

await writeFile(join(TEST_REPO, "a.txt"), "a\n");
await commit("init");

// feature/dark-mode (slash branch) with a couple of commits
await git(["checkout", "-b", "feature/dark-mode"]);
await mkdir(join(TEST_REPO, "src/theme"), { recursive: true });
await writeFile(join(TEST_REPO, "src/theme/dark.css"), "dark\n");
await commit("add dark theme tokens");
await writeFile(join(TEST_REPO, "src/theme/dark.css"), "darker\n");
await commit("tune dark contrast");

// feature/auth
await git(["checkout", "main"]);
await git(["checkout", "-b", "feature/auth"]);
await mkdir(join(TEST_REPO, "src/auth"), { recursive: true });
await writeFile(join(TEST_REPO, "src/auth/login.ts"), "login\n");
await commit("add login flow");

// feature/notes — deliberately no context file (missing-file tests)
await git(["checkout", "main"]);
await git(["checkout", "-b", "feature/notes"]);
await writeFile(join(TEST_REPO, "notes.md"), "notes\n");
await commit("add notes doc");

// fix/logout
await git(["checkout", "main"]);
await git(["checkout", "-b", "fix/logout"]);
await mkdir(join(TEST_REPO, "src/auth"), { recursive: true });
await writeFile(join(TEST_REPO, "src/auth/logout.ts"), "logout\n");
await commit("fix logout redirect");

// back to the context-bearing branch
await git(["checkout", "feature/dark-mode"]);

// Bare remote so remote-tracking refs exist (all local, no network).
await execGit("git", ["init", "--bare", REMOTE], {});
await git(["remote", "add", "origin", REMOTE]);
await git(["push", "origin", "main", "feature/dark-mode", "feature/auth", "feature/notes", "fix/logout"]);

const shortHead = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
const initHash = (await git(["rev-list", "--max-parents=0", "HEAD"])).stdout.trim();

// Context files
const branchesDir = join(TEST_REPO, ".pi", "branches");
await mkdir(branchesDir, { recursive: true });
async function writeContext(branch, about, notAbout, tip) {
  const dir = join(branchesDir, dirname(branch));
  await mkdir(dir, { recursive: true });
  const content = [
    "---",
    `branch: ${branch}`,
    "written_at: 2026-08-07",
    `tip: ${tip}`,
    "generated: true",
    "---",
    "",
    "WHAT THIS BRANCH IS ABOUT:",
    about,
    "",
    "WHAT THIS BRANCH IS NOT ABOUT:",
    notAbout,
    "",
  ].join("\n");
  await writeFile(join(branchesDir, `${branch}.md`), content, "utf8");
}
await writeContext("feature/dark-mode", "Dark mode theming across the app.", "Auth, payments, CI.", shortHead);
await writeContext("feature/auth", "Login flow.", "Theme, payments, CI.", shortHead);
await writeContext("fix/logout", "Fix the logout redirect bug.", "Everything else.", shortHead);

// main.md must never be pruned
await writeContext("main", "Mainline.", "Nothing.", shortHead);

// ghost context for a branch that exists nowhere
await writeContext("fix/ghost", "Ghost.", "Ghost.", shortHead);

// ---------------------------------------------------------------------------
// Load the extension
// ---------------------------------------------------------------------------

console.log("\n== load ==");
const factory = await jiti.import(EXT_FILE, { default: true });
check("factory is a function", typeof factory === "function");
const pi = makeFakePi();
factory(pi.api);
check("tool branch_scope_choice registered", pi.tools.has("branch_scope_choice"));
check("command branch-scaffold registered", pi.commands.has("branch-scaffold"));

const beforeAgentStart = pi.handlers.get("before_agent_start")?.[0];
const sessionStart = pi.handlers.get("session_start")?.[0];
const scaffoldCmd = pi.commands.get("branch-scaffold");
check("before_agent_start handler registered", typeof beforeAgentStart === "function");
check("session_start handler registered", typeof sessionStart === "function");

// ---------------------------------------------------------------------------
// Pruning — FIRST, before any other session_start call (the per-process guard
// only allows one pass per repo per process).
// ---------------------------------------------------------------------------

console.log("\n== pruning ==");
// fix/logout: delete the local branch, keep the remote-tracking ref → must be kept.
await git(["checkout", "feature/auth"]);
await git(["branch", "-D", "fix/logout"]);
// fix/ghost: exists nowhere → must be hard-deleted + logged.
const ghostFile = join(branchesDir, "fix", "ghost.md");
const logoutFile = join(branchesDir, "fix", "logout.md");
check("fix/ghost.md exists before prune", existsSync(ghostFile));
check("fix/logout.md exists before prune", existsSync(logoutFile));

await sessionStart({ type: "session_start", reason: "new" }, makeCtx(TEST_REPO));

const pruned = await waitFor(() => !existsSync(ghostFile));
check("fix/ghost.md deleted (no refs)", pruned);
check("fix/logout.md kept (remote-tracking ref)", existsSync(logoutFile));
check("feature/dark-mode.md kept (has ref)", existsSync(join(branchesDir, "feature", "dark-mode.md")));
check("main.md kept (never pruned)", existsSync(join(branchesDir, "main.md")));
check("current branch file kept", existsSync(join(branchesDir, "feature", "auth.md")));
const pruneLog = existsSync(join(branchesDir, ".prune.log"))
  ? readFileSync(join(branchesDir, ".prune.log"), "utf8")
  : "";
check("prune logged the deletion", hasSubstring(pruneLog, "deleted fix/ghost"));
check("prune log does not mention fix/logout", !hasSubstring(pruneLog, "fix/logout"));

// Per-process guard: a second pass (even after the remote-tracking ref is gone)
// must not run in the same process.
await git(["branch", "-r", "-d", "origin/fix/logout"]);
const logoutBefore = existsSync(logoutFile);
await sessionStart({ type: "session_start", reason: "new" }, makeCtx(TEST_REPO));
await new Promise((r) => setTimeout(r, 300));
check("one prune pass per process (guard)", existsSync(logoutFile) === logoutBefore);

// ---------------------------------------------------------------------------
// Injection: context present, per-session default
// ---------------------------------------------------------------------------

console.log("\n== injection (per-session) ==");
await git(["checkout", "feature/dark-mode"]);
await sessionStart({ type: "session_start", reason: "new" }, makeCtx(TEST_REPO));
let ctx = makeCtx(TEST_REPO);
let result = await beforeAgentStart({ prompt: "hi", systemPrompt: "base", systemPromptOptions: {} }, ctx);
check("returns a message on context-bearing branch", result?.message != null);
check(
  "block has ABOUT content",
  hasSubstring(result?.message?.content, "WHAT THIS BRANCH IS ABOUT") &&
    hasSubstring(result?.message?.content, "Dark mode theming"),
);
check(
  "block has NOT ABOUT content",
  hasSubstring(result?.message?.content, "WHAT THIS BRANCH IS NOT ABOUT"),
);
check(
  "block names the tool in scope rules",
  hasSubstring(result?.message?.content, "branch_scope_choice"),
);
check(
  "block has framing line",
  hasSubstring(result?.message?.content, "use it as given instead of asking the user to restate"),
);
check("message customType", result?.message?.customType === "branch-context");
check("message display", result?.message?.display === true);
check(
  "message details carry repo+branch",
  result?.message?.details?.repo === TEST_REPO && result?.message?.details?.branch === "feature/dark-mode",
);
check("tool activated", pi.activeTools().includes("branch_scope_choice"));

// second call: per-session dedupe
result = await beforeAgentStart({ prompt: "hi again", systemPrompt: "base", systemPromptOptions: {} }, ctx);
check("second per-session call returns nothing (no dup)", result?.message == null && result?.systemPrompt == null);

// resume: fresh session_start (in-memory set cleared) but the persisted session
// already contains the message → must not re-inject.
await sessionStart({ type: "session_start", reason: "resume" }, makeCtx(TEST_REPO));
const resumedEntries = [
  {
    type: "custom_message",
    customType: "branch-context",
    content: "existing",
    details: { repo: TEST_REPO, branch: "feature/dark-mode" },
  },
];
result = await beforeAgentStart(
  { prompt: "hi", systemPrompt: "base", systemPromptOptions: {} },
  makeCtx(TEST_REPO, { entries: resumedEntries }),
);
check("resume with existing message does not re-inject", result?.message == null);

// ---------------------------------------------------------------------------
// Injection: excluded branch (main)
// ---------------------------------------------------------------------------

console.log("\n== injection (excluded branch) ==");
await git(["checkout", "main"]);
await sessionStart({ type: "session_start", reason: "new" }, makeCtx(TEST_REPO));
result = await beforeAgentStart({ prompt: "hi", systemPrompt: "base", systemPromptOptions: {} }, makeCtx(TEST_REPO));
check("main → no injection", result?.message == null && result?.systemPrompt == null);
check("main → tool deactivated", !pi.activeTools().includes("branch_scope_choice"));

// ---------------------------------------------------------------------------
// Injection: missing context file → one-time notice
// ---------------------------------------------------------------------------

console.log("\n== injection (missing file) ==");
await git(["checkout", "feature/notes"]);
await sessionStart({ type: "session_start", reason: "new" }, makeCtx(TEST_REPO));
result = await beforeAgentStart({ prompt: "hi", systemPrompt: "base", systemPromptOptions: {} }, makeCtx(TEST_REPO));
check("missing file → notice returned", hasSubstring(result?.message?.content, "/branch-scaffold"));
check("missing file → details.missing", result?.message?.details?.missing === true);
check(
  "notice carries the proactive-offer guidance",
  hasSubstring(result?.message?.content, "want me to create one"),
);
check(
  "guidance embeds the structure template",
  hasSubstring(result?.message?.content, "generated: true") &&
    hasSubstring(result?.message?.content, "WHAT THIS BRANCH IS ABOUT"),
);
check(
  "guidance tells the agent to ask questions",
  hasSubstring(result?.message?.content, "ASK the user questions"),
);
check(
  "guidance forbids reading extension source",
  hasSubstring(result?.message?.content, "Do NOT read the branch-context extension"),
);
result = await beforeAgentStart({ prompt: "hi again", systemPrompt: "base", systemPromptOptions: {} }, makeCtx(TEST_REPO));
check("missing file → no repeat notice", result?.message == null);

// suggestScaffold: false → plain notice only, no guidance
console.log("\n== injection (missing file, suggestScaffold=false) ==");
await git(["checkout", "-b", "feature/no-suggest"]);
await writeFile(join(TEST_REPO, "nosuggest.md"), "x\n");
// stage only the test file — a blanket `git add -A` here would commit the
// untracked .pi/ dir into this branch and `git checkout feature/auth` below
// would then delete .pi/branches/*.md from the working tree.
await git(["add", "nosuggest.md"]);
await git(["commit", "-m", "no-suggest scaffold test"]);
await writeFile(
  join(TEST_REPO, ".pi", "branch-context.json"),
  JSON.stringify({ suggestScaffold: false }, null, 2),
  "utf8",
);
await sessionStart({ type: "session_start", reason: "new" }, makeCtx(TEST_REPO));
result = await beforeAgentStart({ prompt: "hi", systemPrompt: "base", systemPromptOptions: {} }, makeCtx(TEST_REPO));
check("suggestScaffold=false → notice still shown", hasSubstring(result?.message?.content, "/branch-scaffold"));
check(
  "suggestScaffold=false → no offer guidance",
  !hasSubstring(result?.message?.content, "want me to create one"),
);
check("suggestScaffold=false → details flag", result?.message?.details?.suggestScaffold === false);
result = await beforeAgentStart({ prompt: "hi again", systemPrompt: "base", systemPromptOptions: {} }, makeCtx(TEST_REPO));
check("suggestScaffold=false → no repeat notice", result?.message == null);
// restore default state for the sections below
await rm(join(TEST_REPO, ".pi", "branch-context.json"), { force: true });
await git(["checkout", "feature/auth"]);
await git(["branch", "-D", "feature/no-suggest"]);

// ---------------------------------------------------------------------------
// every-turn mode + truncation + stale flag
// ---------------------------------------------------------------------------

console.log("\n== injection (every-turn, truncation, stale) ==");
await writeFile(
  join(TEST_REPO, ".pi", "branch-context.json"),
  JSON.stringify({ inject: "every-turn", maxWords: 30, staleThresholdCommits: 1 }, null, 2),
  "utf8",
);
await git(["checkout", "feature/dark-mode"]);
await sessionStart({ type: "session_start", reason: "new" }, makeCtx(TEST_REPO));

// stale tip: point the tip at the root (init) commit → drift = all branch commits
// (2) > threshold 1; long body → maxWords truncation kicks in.
const longAbout =
  "Dark mode theming across the entire application surface, including the sidebar, " +
  "toolbar, dialogs, context menus, scrollbars, code blocks, tables, badges, tabs, " +
  "breadcrumbs, dropdowns, checkboxes, radio buttons, form fields, and empty states, " +
  "following the design tokens documented in docs/theme.md and the accessibility " +
  "guidelines in docs/a11y.md.";
await writeContext("feature/dark-mode", longAbout, "Auth, payments, CI.", initHash.slice(0, 8));

result = await beforeAgentStart({ prompt: "hi", systemPrompt: "base", systemPromptOptions: {} }, makeCtx(TEST_REPO));
check("every-turn → systemPrompt appended", hasSubstring(result?.systemPrompt, "<branch-context"));
check("every-turn appends to given prompt", result?.systemPrompt.startsWith("base"));
result = await beforeAgentStart({ prompt: "hi2", systemPrompt: "base2", systemPromptOptions: {} }, makeCtx(TEST_REPO));
check("every-turn appends every call", hasSubstring(result?.systemPrompt, "<branch-context"));
check("stale note present", hasSubstring(result?.systemPrompt, "[may be stale:"));
check("truncated note present", hasSubstring(result?.systemPrompt, "(truncated)"));

// restore sane config + context
await writeFile(
  join(TEST_REPO, ".pi", "branch-context.json"),
  JSON.stringify({ inject: "per-session", maxWords: 300, staleThresholdCommits: 20 }, null, 2),
  "utf8",
);
await writeContext("feature/dark-mode", "Dark mode theming across the app.", "Auth, payments, CI.", shortHead);
await git(["checkout", "feature/dark-mode"]);
await sessionStart({ type: "session_start", reason: "new" }, makeCtx(TEST_REPO));

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

console.log("\n== branch_scope_choice tool ==");
const tool = pi.tools.get("branch_scope_choice");
const toolResult = await tool.execute(
  "call-1",
  { branch: "feature/dark-mode", task: "add payment gateway", suggestedBranch: "feature/payments" },
  undefined,
  undefined,
  makeCtx(TEST_REPO, { hasUI: true, selectResult: "Create a separate branch for this" }),
);
check(
  "separate-branch choice relayed",
  hasSubstring(toolResult.content?.[0]?.text, "Create a separate branch"),
);
check("details.choice", toolResult.details?.choice === "separate-branch");

const toolResult2 = await tool.execute(
  "call-2",
  { branch: "feature/dark-mode", task: "tweak colors" },
  undefined,
  undefined,
  makeCtx(TEST_REPO, { hasUI: true, selectResult: "Implement it here on feature/dark-mode" }),
);
check(
  "implement-here choice relayed",
  hasSubstring(toolResult2.content?.[0]?.text, "Implement the work on the current branch"),
);
check("details.choice", toolResult2.details?.choice === "implement-here");

const toolResult3 = await tool.execute(
  "call-3",
  { branch: "feature/dark-mode", task: "x" },
  undefined,
  undefined,
  makeCtx(TEST_REPO, { hasUI: true, selectResult: undefined }),
);
check(
  "cancelled dialog handled",
  hasSubstring(toolResult3.content?.[0]?.text, "dismissed"),
);

const toolResult4 = await tool.execute(
  "call-4",
  { branch: "feature/dark-mode", task: "x" },
  undefined,
  undefined,
  makeCtx(TEST_REPO, { hasUI: false }),
);
check(
  "no-UI mode handled",
  hasSubstring(toolResult4.content?.[0]?.text, "no interactive UI"),
);

// ---------------------------------------------------------------------------
// /branch-scaffold
// ---------------------------------------------------------------------------

console.log("\n== /branch-scaffold ==");
await git(["checkout", "feature/auth"]);
await sessionStart({ type: "session_start", reason: "new" }, makeCtx(TEST_REPO));
const authFile = join(branchesDir, "feature", "auth.md");
const authBefore = readFileSync(authFile, "utf8");
const notifySink = [];
pi.sent.length = 0;
await scaffoldCmd.handler("", makeCtx(TEST_REPO, { notifySink }));
check("scaffold sent exactly one user message", pi.sent.length === 1);
const sent = pi.sent[0] ?? "";
check("sent message names the branch", hasSubstring(sent, "feature/auth"));
check("sent message names the target file", hasSubstring(sent, ".pi/branches/feature/auth.md"));
check("sent message requires ABOUT section", hasSubstring(sent, "WHAT THIS BRANCH IS ABOUT"));
check("sent message requires generated marker", hasSubstring(sent, "generated: true"));
check("sent message instructs to ask questions", hasSubstring(sent, "ASK the user questions"));
check("scaffold did not modify the existing file", readFileSync(authFile, "utf8") === authBefore);
check("scaffold notifies that the agent will research", notifySink.some((m) => hasSubstring(m, "research")));

// Regression: scaffold on a slash branch whose branches/ subdir does NOT exist
// (e.g. feat/mobile-support → .pi/branches/feat/ is absent). The handler must
// NOT touch the filesystem — no file, no dir. The agent creates the subdir
// when it writes the file, so no mkdir/ENOENT path exists anymore.
await git(["checkout", "-b", "feat/mobile-support"]);
await writeFile(join(TEST_REPO, "mobile.md"), "mobile\n");
await git(["add", "-A"]);
await git(["commit", "-m", "mobile support scaffold"]);
await rm(join(branchesDir, "feat"), { recursive: true, force: true });
check("feat/ dir absent before scaffold", !existsSync(join(branchesDir, "feat")));
pi.sent.length = 0;
await scaffoldCmd.handler("", makeCtx(TEST_REPO, { notifySink }));
check("slash-branch scaffold sent one message", pi.sent.length === 1);
check(
  "slash-branch message names feat target",
  hasSubstring(pi.sent[0] ?? "", ".pi/branches/feat/mobile-support.md"),
);
check(
  "slash-branch scaffold wrote no file",
  !existsSync(join(branchesDir, "feat", "mobile-support.md")),
);
check("slash-branch scaffold created no subdir", !existsSync(join(branchesDir, "feat")));
await git(["checkout", "feature/auth"]);

// ---------------------------------------------------------------------------
// Non-git / detached / untrusted
// ---------------------------------------------------------------------------

console.log("\n== edge cases ==");
await rm("/tmp/bc-nongit", { recursive: true, force: true });
await mkdir("/tmp/bc-nongit", { recursive: true });
result = await beforeAgentStart(
  { prompt: "hi", systemPrompt: "base", systemPromptOptions: {} },
  makeCtx("/tmp/bc-nongit"),
);
check("non-git cwd → nothing", result?.message == null && result?.systemPrompt == null);

await git(["checkout", "--detach", "HEAD"]);
result = await beforeAgentStart(
  { prompt: "hi", systemPrompt: "base", systemPromptOptions: {} },
  makeCtx(TEST_REPO),
);
check("detached HEAD → nothing", result?.message == null && result?.systemPrompt == null);
await git(["checkout", "feature/auth"]);

result = await beforeAgentStart(
  { prompt: "hi", systemPrompt: "base", systemPromptOptions: {} },
  makeCtx(TEST_REPO, { trusted: false }),
);
check("untrusted project → nothing", result?.message == null && result?.systemPrompt == null);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:", failures.join(", "));
  process.exit(1);
}
console.log("SMOKE TEST OK");
