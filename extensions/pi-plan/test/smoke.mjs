// Smoke test for @mattschoe/pi-plan.
//
// Loads the extension through jiti using the same alias mechanism pi's loader
// uses, then drives its handlers against a scratch dir with a fake pi/ctx.
// No real pi instance required.
//
// Run: node test/smoke.mjs   (from the package dir)
//      PI_DIR=/path/to/pi-coding-agent node test/smoke.mjs

import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const PI_DIR =
  process.env.PI_DIR ?? "/home/matt/.local/lib/node_modules/@earendil-works/pi-coding-agent";
const HERE = dirname(new URL(import.meta.url).pathname);
const PKG_DIR = join(HERE, "..");
const EXT_FILE = join(PKG_DIR, "extensions", "index.ts");
const WORK_DIR = "/tmp/pi-plan-test";
const AGENT_DIR = join(WORK_DIR, "agent");

// Deterministic config resolution: point the extension's global config lookup
// at an empty scratch dir instead of the developer's real ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

// ---------------------------------------------------------------------------
// Jiti loader with pi's aliases (subset: only what the extension imports)
// ---------------------------------------------------------------------------

const piRequire = createRequire(join(PI_DIR, "package.json"));
// jiti/static is only exported under the "import" condition, so require.resolve
// can't see it — resolve the physical file like the loader does.
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
// Fake pi + ctx
// ---------------------------------------------------------------------------

function makeFakePi() {
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const flags = new Map();
  const entries = [];
  const sent = [];

  const api = {
    entries,
    sent,
    commands,
    shortcuts,
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    emit: async (type, event, ctx) => {
      const results = [];
      for (const handler of handlers.get(type) ?? []) {
        results.push(await handler(event, ctx));
      }
      return results;
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerShortcut(key, def) {
      shortcuts.set(key, def);
    },
    registerFlag(name, def) {
      flags.set(name, def.default);
    },
    getFlag: (name) => flags.get(name),
    setFlag: (name, value) => flags.set(name, value),
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message, options) {
      sent.push({ kind: "message", message, options });
    },
    sendUserMessage(text, options) {
      sent.push({ kind: "user", text, options });
    },
  };
  return api;
}

const identity = (_style, text) => text;

function makeCtx(pi, { cwd = WORK_DIR, selectAnswer, confirmAnswer = true } = {}) {
  const ui = {
    notifications: [],
    statuses: [],
    widgets: [],
    editorText: undefined,
    selectPrompts: [],
    theme: { fg: identity, bold: (t) => t, strikethrough: (t) => t },
    notify: (text, level) => ui.notifications.push({ text, level }),
    setStatus: (key, value) => ui.statuses.push({ key, value }),
    setWidget: (key, value) => ui.widgets.push({ key, value }),
    setEditorText: (text) => {
      ui.editorText = text;
    },
    select: async (prompt, options) => {
      ui.selectPrompts.push({ prompt, options });
      return typeof selectAnswer === "function" ? selectAnswer(options) : selectAnswer;
    },
    confirm: async () => confirmAnswer,
    custom: async () => ({ action: "cancel" }),
  };

  return {
    ui,
    hasUI: true,
    cwd,
    sessionManager: {
      getEntries: () => pi.entries,
      getSessionFile: () => "/tmp/pi-plan-test/session.jsonl",
      getCwd: () => cwd,
    },
  };
}

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
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAN_TEXT = `# Add retry to config fetch

## Context
The config fetcher fails on transient network errors.

## Plan
1. Add a retryTimeout field to src/config.ts
2. Wrap the fetch call in a retry loop with exponential backoff

## Done When
- src/config.ts contains a retryTimeout field set to 5000.
`;

const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await rm(WORK_DIR, { recursive: true, force: true });
await mkdir(AGENT_DIR, { recursive: true });

const mod = await jiti.import(EXT_FILE);
const extension = mod.default;

section("Registration");
{
  const pi = makeFakePi();
  extension(pi);
  check("registers /plan-approve", pi.commands.has("plan-approve"));
  check("registers /plans", pi.commands.has("plans"));
  check("registers /execute-plan", pi.commands.has("execute-plan"));
  check("registers /todos", pi.commands.has("todos"));
  check("does not register the retired /plan toggle", !pi.commands.has("plan"));
  check("registers the mode-cycle shortcut on the default key", pi.shortcuts.has("f6"));
}

section("Mode cycling and prompt injection");
{
  const pi = makeFakePi();
  extension(pi);
  const ctx = makeCtx(pi);
  await pi.emit("session_start", {}, ctx);

  const cycle = pi.shortcuts.get("f6").handler;

  // default -> acceptEdits
  await cycle(ctx);
  let [result] = await pi.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);
  check("accept-edits injects its system prompt", result.systemPrompt?.includes("[ACCEPT EDITS MODE]"));

  // acceptEdits -> plan
  await cycle(ctx);
  [result] = await pi.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);
  check("plan mode injects its system prompt", result.systemPrompt?.includes("[PLAN MODE ACTIVE]"));
  check("plan prompt keeps the base prompt", result.systemPrompt?.startsWith("BASE"));
  check("plan prompt asks for a Done When section", result.systemPrompt?.includes("## Done When"));

  // plan -> default
  await cycle(ctx);
  [result] = await pi.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);
  check("default mode injects nothing", result.systemPrompt === undefined);

  check("mode is persisted to the session", pi.entries.some((e) => e.customType === "pledit-mode"));

  // Legacy sessions carry hidden "[PLAN MODE ACTIVE]" messages that must not
  // survive into a context where plan mode is a system-prompt injection.
  const [filtered] = await pi.emit(
    "context",
    {
      messages: [
        { role: "user", content: "real message" },
        { role: "user", customType: "plan-mode-context", content: "[PLAN MODE ACTIVE] ..." },
      ],
    },
    ctx,
  );
  check("stale plan-mode-context messages are dropped", filtered.messages.length === 1);
  check("real messages survive the filter", filtered.messages[0].content === "real message");
}

section("Tool gating");
{
  const pi = makeFakePi();
  extension(pi);
  const ctx = makeCtx(pi, { confirmAnswer: false });
  await pi.emit("session_start", {}, ctx);
  const cycle = pi.shortcuts.get("f6").handler;

  const call = async (toolName, input) => (await pi.emit("tool_call", { toolName, input }, ctx))[0];

  // default mode
  check("default mode allows read-only bash silently", !(await call("bash", { command: "git status" })).block);
  check("default mode prompts on other bash", (await call("bash", { command: "npm publish" })).block);
  check("default mode prompts on write", (await call("write", { file_path: "a.ts" })).block);

  await cycle(ctx); // acceptEdits
  check("accept-edits allows ordinary bash", !(await call("bash", { command: "npm test" })).block);
  check("accept-edits allows write", !(await call("write", { file_path: "a.ts" })).block);
  check("accept-edits prompts on sudo (restored default)", (await call("bash", { command: "sudo apt install x" })).block);
  check(
    "accept-edits prompts on docker system prune (restored default)",
    (await call("bash", { command: "docker system prune" })).block,
  );
  check(
    "unsafe match survives env/wrapper prefixes",
    (await call("bash", { command: "FOO=1 timeout 5 sudo rm -rf /" })).block,
  );

  await cycle(ctx); // plan
  check("plan mode blocks write", (await call("write", { file_path: "a.ts" })).block);
  check("plan mode blocks edit", (await call("edit", { file_path: "a.ts" })).block);
  check("plan mode blocks non-read-only bash", (await call("bash", { command: "rm file" })).block);
  check("plan mode allows read-only bash", !(await call("bash", { command: "git log" })).block);
  check("plan mode allows read", !(await call("read", { file_path: "a.ts" })).block);
}

section("Plan capture — option 4 (new chat)");
{
  const pi = makeFakePi();
  extension(pi);
  const ctx = makeCtx(pi, {
    selectAnswer: (options) => options.find((o) => o.startsWith("4.")),
  });
  await pi.emit("session_start", {}, ctx);
  await pi.shortcuts.get("f6").handler(ctx); // acceptEdits
  await pi.shortcuts.get("f6").handler(ctx); // plan

  await pi.emit("agent_end", { messages: [assistant(PLAN_TEXT)] }, ctx);

  const plansDir = join(WORK_DIR, ".pi", "plans");
  const files = existsSync(plansDir) ? readdirSync(plansDir) : [];
  check("writes exactly one plan file", files.length === 1, `got ${JSON.stringify(files)}`);
  check(
    "plan file is named from the plan's title",
    files[0]?.startsWith("add-retry-to-config-fetch-"),
    files[0],
  );

  const content = readFileSync(join(plansDir, files[0]), "utf-8");
  check("plan file has frontmatter", content.startsWith("---\n"));
  check("plan file keeps the plan body", content.includes("# Add retry to config fetch"));
  check("plan file has no injected '# Plan' wrapper", !content.includes("\n# Plan\n"));

  check("todo list is shown", pi.sent.some((s) => s.message?.customType === "plan-todo-list"));
  check(
    "extracted both plan steps",
    pi.sent.find((s) => s.message?.customType === "plan-todo-list")?.message.content.includes("Plan Steps (2)"),
  );
  check("dialog offered four options", ctx.ui.selectPrompts[0]?.options.length === 4);
  check("option 4 prefills /plan-approve", ctx.ui.editorText?.startsWith("/plan-approve .pi/plans/add-retry"));
  check("option 4 does not start execution", !pi.entries.some((e) => e.customType === "plan-mode-execute"));

  const modeEntries = pi.entries.filter((e) => e.customType === "pledit-mode");
  check("stays in plan mode after option 4", modeEntries.at(-1)?.data.mode === "plan");
}

section("Plan capture — option 1 (execute here) and tracking");
{
  await rm(join(WORK_DIR, ".pi"), { recursive: true, force: true });
  const pi = makeFakePi();
  extension(pi);
  const ctx = makeCtx(pi, {
    selectAnswer: (options) => options.find((o) => o.startsWith("1.")),
  });
  await pi.emit("session_start", {}, ctx);
  await pi.shortcuts.get("f6").handler(ctx);
  await pi.shortcuts.get("f6").handler(ctx); // plan

  await pi.emit("agent_end", { messages: [assistant(PLAN_TEXT)] }, ctx);

  check(
    "option 1 switches to accept-edits",
    pi.entries.filter((e) => e.customType === "pledit-mode").at(-1)?.data.mode === "acceptEdits",
  );
  check("option 1 starts execution tracking", pi.entries.some((e) => e.customType === "plan-mode-execute"));
  const tracking = pi.entries.filter((e) => e.customType === "plan-mode").at(-1);
  check("tracking state has both steps", tracking?.data.todos.length === 2);
  check("tracking state captured Done When", Boolean(tracking?.data.doneWhenText));
  check("kickoff message was sent", pi.sent.some((s) => s.kind === "user" && s.text.includes("Start with step 1")));

  // Execution context is injected while steps remain
  const [beforeStart] = await pi.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);
  check("execution context is injected", beforeStart.message?.customType === "plan-execution-context");
  check("execution context lists remaining steps", beforeStart.message?.content.includes("[DONE:n]"));

  // Step 1 done
  await pi.emit("turn_end", { message: assistant("Did the thing. [DONE:1]") }, ctx);
  check(
    "step 1 marked complete",
    pi.entries.filter((e) => e.customType === "plan-mode").at(-1).data.todos[0].completed === true,
  );
  check("progress status rendered", ctx.ui.statuses.some((s) => s.value?.includes("1/2")));

  // Not all steps done -> no verification yet
  await pi.emit("agent_end", { messages: [] }, ctx);
  check("no verification while steps remain", !pi.sent.some((s) => s.kind === "user" && s.text.includes("verify against")));

  // Step 2 done -> verification fires
  await pi.emit("turn_end", { message: assistant("And the other. [DONE:2]") }, ctx);
  await pi.emit("agent_end", { messages: [] }, ctx);
  check(
    "verification prompt fires once all steps are done",
    pi.sent.some((s) => s.kind === "user" && s.text.includes("verify against your success criteria")),
  );

  // Verification answered -> plan closes out
  await pi.emit("agent_end", { messages: [] }, ctx);
  check("plan closes out after verification", pi.sent.some((s) => s.message?.customType === "plan-complete"));
  check("widget is cleared", ctx.ui.widgets.at(-1)?.value === undefined);
}

section("Resume");
{
  const pi = makeFakePi();
  extension(pi);
  const ctx = makeCtx(pi);

  const todos = [
    { step: 1, text: "Add a retryTimeout field", completed: false },
    { step: 2, text: "Wrap the fetch call", completed: false },
  ];
  // A previous, unrelated plan left a stale [DONE:2] in the transcript.
  pi.entries.push({ type: "message", message: assistant("Old plan work. [DONE:2]") });
  pi.entries.push({ type: "custom", customType: "pledit-mode", data: { mode: "acceptEdits" } });
  pi.entries.push({
    type: "custom",
    customType: "plan-mode",
    data: { enabled: false, todos, executing: true, doneWhenText: "criteria" },
  });
  pi.entries.push({ type: "custom", customType: "plan-mode-execute", data: {} });
  pi.entries.push({ type: "message", message: assistant("New plan work. [DONE:1]") });

  await pi.emit("session_start", {}, ctx);

  const cmd = pi.commands.get("todos");
  await cmd.handler("", ctx);
  const printed = ctx.ui.notifications.at(-1).text;
  check("resume restores todos", printed.includes("Add a retryTimeout field"));
  check("resume re-marks step 1 from the transcript", printed.includes("1. ✓"));
  check("resume ignores [DONE:2] from before the execute marker", printed.includes("2. ○"), printed);
  check("resume restores accept-edits mode", ctx.ui.statuses.at(-1)?.value?.includes("accept edits"));
}

section("Plan resolution");
{
  const plansDir = join(WORK_DIR, ".pi", "plans");
  await mkdir(plansDir, { recursive: true });
  await writeFile(join(plansDir, "renamed-2026-01-02T03-04-05.md"), `---\nmode: "plan"\n---\n\n${PLAN_TEXT}`);

  const pi = makeFakePi();
  extension(pi);
  let newSessionOptions;
  const ctx = {
    ...makeCtx(pi),
    waitForIdle: async () => {},
    newSession: async (options) => {
      newSessionOptions = options;
      const appended = [];
      await options.setup({
        appendMessage: (m) => appended.push({ kind: "message", m }),
        appendCustomEntry: (customType, data) => appended.push({ kind: "custom", customType, data }),
      });
      newSessionOptions.appended = appended;
      await options.withSession({ sendUserMessage: async (t) => (newSessionOptions.kickoff = t) });
      return { cancelled: false };
    },
  };

  // A stale name that only matches on the timestamp component still resolves.
  await pi.commands.get("plan-approve").handler("plans/old-name-2026-01-02T03-04-05.md", ctx);
  check("plan-approve resolves a plan by its timestamp", Boolean(newSessionOptions));
  const appended = newSessionOptions?.appended ?? [];
  check("new chat is seeded with the plan body", appended[0]?.m.content[0].text.includes("# Add retry"));
  check(
    "new chat starts in accept-edits",
    appended.some((a) => a.customType === "pledit-mode" && a.data.mode === "acceptEdits"),
  );
  check(
    "new chat is seeded with tracking state",
    appended.some((a) => a.customType === "plan-mode" && a.data.executing === true),
  );
  check(
    "new chat gets an execute marker",
    appended.some((a) => a.customType === "plan-mode-execute"),
  );
  check("new chat kickoff names step 1", newSessionOptions?.kickoff?.includes("Start with step 1"));

  await pi.commands.get("plan-approve").handler("does-not-exist.md", ctx);
  check(
    "missing plan file reports an error",
    ctx.ui.notifications.at(-1)?.level === "error",
  );
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
