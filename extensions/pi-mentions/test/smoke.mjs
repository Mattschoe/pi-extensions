// Smoke test for pi-mentions.
//
// Loads the extension through jiti using the same alias mechanism pi's loader
// uses, then drives its handlers against a real scratch git repo (/tmp/
// pi-mentions-test) and a scripted fake `gh`, with a fake pi/ctx. No real pi
// instance required.
//
// Run: node test/smoke.mjs   (from the package dir)
//      PI_DIR=/path/to/pi-coding-agent node test/smoke.mjs

import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const PI_DIR =
  process.env.PI_DIR ?? "/home/matt/.local/lib/node_modules/@earendil-works/pi-coding-agent";
const HERE = dirname(new URL(import.meta.url).pathname);
const PKG_DIR = join(HERE, "..");
const EXT_FILE = join(PKG_DIR, "extensions", "index.ts");
const WORK_DIR = "/tmp/pi-mentions-test";
const REPO = join(WORK_DIR, "repo");
const PLAIN = join(WORK_DIR, "plain");

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

function run(cmd, args, opts = {}) {
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

/**
 * `gh` is never actually invoked: every call is answered by `ghResponder`,
 * which each section swaps for the behaviour it wants (absent, unauthenticated,
 * a working issue list). `git` runs for real against the scratch repo.
 */
function makeFakePi(ghResponder) {
  const handlers = new Map();
  const shortcuts = new Map();
  const renderers = new Map();
  const execCalls = [];

  const api = {
    execCalls,
    shortcuts,
    renderers,
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    handler: (type, index = 0) => handlers.get(type)?.[index],
    registerShortcut(key, def) {
      shortcuts.set(key, def);
    },
    registerMessageRenderer(customType, renderer) {
      renderers.set(customType, renderer);
    },
    async exec(cmd, args, opts) {
      execCalls.push({ cmd, args, opts });
      if (cmd === "gh") return ghResponder(args, opts);
      return run(cmd, args, opts);
    },
  };
  return api;
}

/** `gh` is not installed: pi.exec resolves non-zero rather than throwing. */
const ghAbsent = () => ({ stdout: "", stderr: "gh: command not found", code: 127, killed: false });

const ISSUES = [
  { number: 7, title: "Flaky retry on config fetch", state: "OPEN" },
  { number: 412, title: "Login crashes on empty password", state: "OPEN" },
  { number: 415, title: "Dark mode contrast on badges", state: "OPEN" },
];

const comment = (login, body, { at = "2026-03-01T10:00:00Z", assoc = "NONE", hidden } = {}) => ({
  author: login === null ? null : { login },
  authorAssociation: assoc,
  body,
  createdAt: at,
  isMinimized: hidden !== undefined,
  minimizedReason: hidden ?? null,
  reactionGroups: [],
});

// #412 exercises the filters: a maintainer, a bot, a deleted account, a hidden
// spam comment, and a reaction-only row with no text.
// #7 is six plain comments, so the maxComments math is readable in assertions.
const COMMENTS = {
  412: [
    comment("alice", "Root cause is the password validator, not the form.", {
      assoc: "MEMBER",
      at: "2026-03-01T10:00:00Z",
    }),
    comment("dependabot[bot]", "Bumped the auth dependency.", { at: "2026-03-02T10:00:00Z" }),
    comment(null, "Seeing this on 2.1 as well.", { at: "2026-03-03T10:00:00Z" }),
    comment("spammer", "BUY CHEAP WATCHES", { at: "2026-03-04T10:00:00Z", hidden: "SPAM" }),
    comment("bob", "Fix should go behind a flag.", { at: "2026-03-05T10:00:00Z" }),
    comment("carol", "   ", { assoc: "OWNER", at: "2026-03-06T10:00:00Z" }),
  ],
  7: ["one", "two", "three", "four", "five", "six"].map((n, i) =>
    comment(`user${i + 1}`, `comment ${n}`, { at: `2026-04-0${i + 1}T10:00:00Z` }),
  ),
  415: [],
};

// #415 is long enough to truncate; the others stay short.
const bodyFor = (number) =>
  number === 415
    ? Array.from({ length: 40 }, (_, i) => `body line ${i + 1}`).join("\n")
    : `Body of issue ${number}.\nMore.`;

function ghWorking({ authOk = true } = {}) {
  return (args) => {
    const ok = (stdout) => ({ stdout, stderr: "", code: 0, killed: false });
    const fail = (stderr) => ({ stdout: "", stderr, code: 1, killed: false });
    if (args[0] === "auth") return authOk ? ok("Logged in") : fail("not logged in");
    if (args[0] === "issue" && args[1] === "list") return ok(JSON.stringify(ISSUES));
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("--web")) return ok("Opening in browser");
      const number = Number.parseInt(args[2], 10);
      const issue = ISSUES.find((i) => i.number === number);
      if (!issue) return fail("issue not found");
      // Mirror gh: `comments` comes back only when it was asked for.
      const fields = args[args.indexOf("--json") + 1] ?? "";
      const payload = { title: issue.title, body: bodyFor(number) };
      if (fields.split(",").includes("comments")) payload.comments = COMMENTS[number] ?? [];
      return ok(JSON.stringify(payload));
    }
    return fail(`unexpected gh ${args.join(" ")}`);
  };
}

function makeCtx(cwd, { hasUI = true, editorText = "", selectAnswer } = {}) {
  const ui = {
    notifications: [],
    widgets: [],
    providerFactories: [],
    editorFactories: [],
    selectPrompts: [],
    notify: (text, level) => ui.notifications.push({ text, level }),
    setWidget: (key, value) => ui.widgets.push({ key, value }),
    getEditorText: () => editorText,
    addAutocompleteProvider: (factory) => ui.providerFactories.push(factory),
    setEditorComponent: (factory) => ui.editorFactories.push(factory),
    select: async (prompt, options) => {
      ui.selectPrompts.push({ prompt, options });
      return typeof selectAnswer === "function" ? selectAnswer(options) : selectAnswer;
    },
  };
  return { cwd, hasUI, ui };
}

/** Stands in for pi's built-in `@` file picker, which our provider wraps. */
const baseProvider = {
  triggerCharacters: ["@"],
  async getSuggestions(lines, cursorLine, cursorCol) {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const at = before.lastIndexOf("@");
    if (at === -1) return null;
    const query = before.slice(at + 1);
    const files = ["src/app.ts", "src/uncommon.ts", "docs/api.md"].filter((f) =>
      f.includes(query.replace(/^"/, "")),
    );
    if (files.length === 0) return null;
    return { items: files.map((f) => ({ value: `@${f}`, label: f })), prefix: `@${query}` };
  },
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const line = lines[cursorLine] ?? "";
    const start = cursorCol - prefix.length;
    const next = [...lines];
    next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
    return { lines: next, cursorLine, cursorCol: start + item.value.length };
  },
};

const suggest = (provider, text) =>
  provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });

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

function section(name) {
  console.log(`\n== ${name} ==`);
}

const has = (haystack, needle) => typeof haystack === "string" && haystack.includes(needle);
const values = (result) => (result?.items ?? []).map((i) => i.value);

// ---------------------------------------------------------------------------
// Scratch repo
// ---------------------------------------------------------------------------

await rm(WORK_DIR, { recursive: true, force: true });
await mkdir(REPO, { recursive: true });
await mkdir(PLAIN, { recursive: true });

const git = (args, cwd = REPO) => run("git", args, { cwd });

await git(["init", "-b", "main"]);
await git(["config", "user.email", "t@t"]);
await git(["config", "user.name", "t"]);
await writeFile(join(REPO, "a.txt"), "a\n");
await git(["add", "-A"]);
await git(["commit", "-m", "initial commit"]);
await writeFile(join(REPO, "b.txt"), "b\n");
await git(["add", "-A"]);
await git(["commit", "-m", "add b"]);

const headHash = (await git(["rev-parse", "HEAD"])).stdout.trim();

// Dirty working tree for the `@uncommitted` tests.
await writeFile(join(REPO, "a.txt"), "a\nchanged\n");

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

section("load");
const factory = await jiti.import(EXT_FILE, { default: true });
check("default export is a function", typeof factory === "function");

const piGitOnly = makeFakePi(ghAbsent);
factory(piGitOnly);
check("registers the alt+g shortcut", piGitOnly.shortcuts.has("alt+g"));
check("registers the issue message renderer", piGitOnly.renderers.has("pi-mentions:issue"));
check(
  "registers the legacy renderer for pre-merge sessions",
  piGitOnly.renderers.has("github-issue-reference"),
);
check("registers an input handler", typeof piGitOnly.handler("input") === "function");
check(
  "registers a before_agent_start handler",
  typeof piGitOnly.handler("before_agent_start") === "function",
);

// ---------------------------------------------------------------------------
// No GitHub: git repo with no remote and no `gh` on PATH
// ---------------------------------------------------------------------------

section("no GitHub (no remote, gh absent)");
const gitOnlyCtx = makeCtx(REPO);
await piGitOnly.handler("session_start")({ type: "session_start" }, gitOnlyCtx);
check("only the @ provider is registered", gitOnlyCtx.ui.providerFactories.length === 1);
check("pi's stock editor is left in place", gitOnlyCtx.ui.editorFactories.length === 0);
check("no notification about the absent GitHub", gitOnlyCtx.ui.notifications.length === 0);

const gitProvider = gitOnlyCtx.ui.providerFactories[0](baseProvider);

// ---------------------------------------------------------------------------
// `@` autocomplete
// ---------------------------------------------------------------------------

section("@ autocomplete");

const bare = await suggest(gitProvider, "explain @");
check("bare @ lists uncommitted first", values(bare)[0] === "@uncommitted");
check("bare @ still lists files after it", values(bare).includes("@src/app.ts"), values(bare));

const partial = await suggest(gitProvider, "explain @un");
check("@un keeps uncommitted above the file matches", values(partial)[0] === "@uncommitted");
check(
  "@un still offers the matching file below",
  values(partial).includes("@src/uncommon.ts"),
  values(partial),
);

const hexPrefix = headHash.slice(0, 4);
const commits = await suggest(gitProvider, `look at @${hexPrefix}`);
check(
  "hex prefix suggests the matching commit",
  values(commits).includes(`@${headHash}`),
  values(commits),
);
check(
  "commits sit below the file matches",
  values(commits).indexOf(`@${headHash}`) === values(commits).length - 1,
);

const noHits = await suggest(gitProvider, "look at @ffffffff");
check("a hash prefix matching nothing yields nothing", (noHits?.items ?? []).length === 0);

const pathToken = await suggest(gitProvider, "read @src/app");
check(
  "a path-shaped token defers wholly to the file picker",
  values(pathToken).length === 1 && values(pathToken)[0] === "@src/app.ts",
  values(pathToken),
);

const quoted = await suggest(gitProvider, 'read @"my file');
check("the @\"…\" quoted form is left to the built-in", quoted === null || values(quoted).length > 0);

check(
  "applyCompletion defers to the wrapped provider for @",
  gitProvider.applyCompletion(["read @src"], 0, 9, { value: "@src/app.ts" }, "@src").lines[0] ===
    "read @src/app.ts",
);

// ---------------------------------------------------------------------------
// `@` injection (the input hook)
// ---------------------------------------------------------------------------

section("@ injection");
const input = piGitOnly.handler("input");

const passthrough = await input({ text: "no mentions here", source: "user" }, makeCtx(REPO));
check("a prompt with no mentions is untouched", passthrough?.action === "continue");

const fromExtension = await input({ text: "@uncommitted", source: "extension" }, makeCtx(REPO));
check("extension-authored input is skipped", fromExtension?.action === "continue");

const noUI = await input({ text: "@uncommitted", source: "user" }, makeCtx(REPO, { hasUI: false }));
check("non-interactive modes are skipped", noUI?.action === "continue");

const uncommitted = await input({ text: "why does @uncommitted break?", source: "user" }, makeCtx(REPO));
check("@uncommitted transforms the prompt", uncommitted?.action === "transform");
check("block is spliced in place", has(uncommitted?.text, "why does <git-uncommitted"));
check("trailing text is preserved", has(uncommitted?.text, "</git-uncommitted> break?"));
check("block carries the cwd", has(uncommitted?.text, `cwd="${REPO}"`));
check("block carries git status", has(uncommitted?.text, "[git status]"));
check("block carries the diff", has(uncommitted?.text, "[git diff HEAD]") && has(uncommitted?.text, "+changed"));
check(
  "block carries the framing line",
  has(uncommitted?.text, "Use them as given instead of asking the user to restate them."),
);

const dedupeCtx = makeCtx(REPO);
const dedupePi = piGitOnly.execCalls.length;
const twice = await input({ text: "@uncommitted vs @uncommitted", source: "user" }, dedupeCtx);
const statusCalls = piGitOnly.execCalls
  .slice(dedupePi)
  .filter((c) => c.args.includes("status") && !c.args.includes("--porcelain"));
check("a repeated reference is fetched once", statusCalls.length === 1, `${statusCalls.length}`);
check(
  "but expanded at both positions",
  (twice?.text.match(/<git-uncommitted/g) ?? []).length === 2,
);

const commit = await input({ text: `explain @${headHash}`, source: "user" }, makeCtx(REPO));
check("@<hash> transforms the prompt", commit?.action === "transform");
check("commit block names the hash", has(commit?.text, `<git-commit hash="${headHash}"`));
check("commit block carries the commit message", has(commit?.text, "add b"));
check(
  "commit block carries the framing line",
  has(commit?.text, "Use it as given instead of asking the user to restate it."),
);

const short = await input({ text: `explain @${headHash.slice(0, 6)}`, source: "user" }, makeCtx(REPO));
check("a 6-hex word is not treated as a hash", short?.action === "continue");

const badHashCtx = makeCtx(REPO);
const badHash = await input({ text: "explain @deadbeefdeadbeef", source: "user" }, badHashCtx);
check("an unknown hash blocks the message", badHash?.action === "handled");
check(
  "and says so",
  badHashCtx.ui.notifications.some((n) => n.level === "error" && has(n.text, "not found")),
);

const nonGitCtx = makeCtx(PLAIN);
const nonGit = await input({ text: "@uncommitted", source: "user" }, nonGitCtx);
check("@uncommitted outside a repo blocks the message", nonGit?.action === "handled");
check(
  "and says why",
  nonGitCtx.ui.notifications.some((n) => has(n.text, "not a git repository")),
);

await git(["add", "-A"]);
await git(["commit", "-m", "commit the change"]);
const clean = await input({ text: "@uncommitted", source: "user" }, makeCtx(REPO));
check(
  "a clean tree injects a short note",
  has(clean?.text, "the working tree is clean — no uncommitted changes."),
  clean?.text,
);
check("and no diff section", !has(clean?.text, "[git diff HEAD]"));
check("and no status section", !has(clean?.text, "[git status]"));

// ---------------------------------------------------------------------------
// GitHub present but `gh` unusable
// ---------------------------------------------------------------------------

section("GitHub remote, gh unauthenticated");
await git(["remote", "add", "origin", "git@github.com:acme/widgets.git"]);

const piUnauth = makeFakePi(ghWorking({ authOk: false }));
factory(piUnauth);
const unauthCtx = makeCtx(REPO);
await piUnauth.handler("session_start")({ type: "session_start" }, unauthCtx);
check("# stays unarmed when gh is not authenticated", unauthCtx.ui.providerFactories.length === 1);
check("no editor swap", unauthCtx.ui.editorFactories.length === 0);
check("no notification", unauthCtx.ui.notifications.length === 0);

const inert = await piUnauth.handler("before_agent_start")(
  { prompt: "fix [#412 - Login crashes on empty password]" },
  unauthCtx,
);
check("issue references are inert without gh", inert === undefined);

await piUnauth.shortcuts.get("alt+g").handler(makeCtx(REPO, { editorText: "[#412 - x]" }));
check(
  "alt+g is silent without gh",
  !piUnauth.execCalls.some((c) => c.cmd === "gh" && c.args.includes("--web")),
);

// ---------------------------------------------------------------------------
// GitHub working
// ---------------------------------------------------------------------------

section("# mentions");
const pi = makeFakePi(ghWorking());
factory(pi);
const ctx = makeCtx(REPO);
await pi.handler("session_start")({ type: "session_start" }, ctx);
check("both providers are registered", ctx.ui.providerFactories.length === 2);
check("the mentions editor is installed", ctx.ui.editorFactories.length === 1);

const issueProvider = ctx.ui.providerFactories[1](baseProvider);

const allIssues = await suggest(issueProvider, "fix #");
check("bare # lists the open issues", values(allIssues).length === ISSUES.length, values(allIssues));
check("rows carry the issue number", values(allIssues)[0] === "#7");
check(
  "rows show number, state and title",
  has(allIssues.items[1].label, "#412") &&
    has(allIssues.items[1].label, "[open]") &&
    has(allIssues.items[1].label, "Login crashes"),
);

const numeric = await suggest(issueProvider, "fix #41");
check("a numeric query prefix-matches", values(numeric).join(",") === "#412,#415", values(numeric));

const fuzzy = await suggest(issueProvider, "fix #contrast");
check("a text query fuzzy-matches the title", values(fuzzy).includes("#415"), values(fuzzy));

check("# replaces rather than stacks on file suggestions", !values(allIssues).some((v) => v.startsWith("@")));

const inserted = issueProvider.applyCompletion(["fix #41"], 0, 7, { value: "#412", label: "#412  [open]  Login crashes on empty password" }, "#41");
check(
  "selecting an issue inserts the bracketed reference",
  inserted.lines[0] === "fix [#412 - Login crashes on empty password]",
  inserted.lines[0],
);
check("cursor lands after the reference", inserted.cursorCol === inserted.lines[0].length);

// The issue body is pre-fetched on selection, so give that microtask chain a turn.
await new Promise((r) => setTimeout(r, 50));

const injected = await pi.handler("before_agent_start")(
  { prompt: "fix [#412 - Login crashes on empty password]" },
  ctx,
);
check("a referenced issue is injected", injected?.message != null);
check("as its own custom message", injected?.message?.customType === "pi-mentions:issue");
check("displayed", injected?.message?.display === true);
check("carrying the heading", has(injected?.message?.content, "## Referenced issue #412 - Login crashes"));
check("carrying the body", has(injected?.message?.content, "Body of issue 412."));

const twoIssues = await pi.handler("before_agent_start")(
  { prompt: "[#7 - Flaky retry on config fetch] blocks [#412 - Login crashes] and [#7 - dup]" },
  ctx,
);
check("multiple issues are injected", has(twoIssues?.message?.content, "#7") && has(twoIssues?.message?.content, "#412"));
check(
  "a repeated reference is injected once",
  (twoIssues.message.content.match(/## Referenced issue #7 /g) ?? []).length === 1,
);

const noRefs = await pi.handler("before_agent_start")({ prompt: "no issues here" }, ctx);
check("a prompt with no references injects nothing", noRefs === undefined);

const unknown = await pi.handler("before_agent_start")({ prompt: "[#999 - nope]" }, ctx);
check("an unresolvable issue injects nothing", unknown === undefined);

// ---------------------------------------------------------------------------
// Issue comments + config
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(REPO, ".pi");

/**
 * Every case writes a *complete* config object. `loadConfig` also reads
 * `~/.pi/mentions.json` and pi's agent dir, and project scope overrides both, so
 * spelling out all six keys keeps the run deterministic on a machine that has a
 * global config.
 */
const CONFIG = {
  includeComments: true,
  maxIssueChars: 0,
  maxComments: 0,
  dropComments: "middle",
  keepBots: true,
  keepMinimized: false,
};

/**
 * A fresh extension instance per case: the issue cache is per-session, so
 * reusing one would serve an earlier case's fetch and hide config changes.
 * Pass a string to write a deliberately broken config file.
 */
async function injectWith(config, prompt) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(
    join(CONFIG_DIR, "mentions.json"),
    typeof config === "string" ? config : JSON.stringify({ ...CONFIG, ...config }),
  );
  const casePi = makeFakePi(ghWorking());
  factory(casePi);
  const caseCtx = makeCtx(REPO);
  await casePi.handler("session_start")({ type: "session_start" }, caseCtx);
  const result = await casePi.handler("before_agent_start")({ prompt }, caseCtx);
  return { pi: casePi, content: result?.message?.content ?? "" };
}

/** The `--json` field list of the last `gh issue view` this case made. */
const jsonFields = (casePi) => {
  const call = casePi.execCalls
    .filter((c) => c.cmd === "gh" && c.args[1] === "view" && c.args.includes("--json"))
    .pop();
  return call ? call.args[call.args.indexOf("--json") + 1] : "";
};

const before = (text, first, second) => text.indexOf(first) < text.indexOf(second);

const REF_412 = "fix [#412 - Login crashes on empty password]";
const REF_415 = "check [#415 - Dark mode contrast on badges]";
const REF_7 = "look at [#7 - Flaky retry on config fetch]";

section("issue comments (defaults)");
const dflt = await injectWith({}, REF_412);
check("comments are injected by default", has(dflt.content, "### Discussion"), dflt.content);
check("the gh query asks for comments", jsonFields(dflt.pi).includes("comments"));
check(
  "the heading counts what survived filtering",
  has(dflt.content, "### Discussion (4 comments)"),
  dflt.content,
);
check(
  "the anti-anchoring framing is present",
  has(dflt.content, "The issue body above is the specification."),
);
check(
  "a maintainer carries their association and date",
  has(dflt.content, "**@alice** (MEMBER) — 2026-03-01"),
  dflt.content,
);
check("a drive-by commenter carries no association", has(dflt.content, "**@bob** — 2026-03-05"));
check("a deleted account renders as ghost", has(dflt.content, "**@ghost**"));
check("bots are kept by default", has(dflt.content, "dependabot[bot]"));
check("comments stay in chronological order", before(dflt.content, "**@alice**", "**@bob**"));
check("minimized comments are dropped by default", !has(dflt.content, "BUY CHEAP WATCHES"));
check("reaction-only comments are dropped", !has(dflt.content, "**@carol**"));
check("nothing cut means no omission marker", !has(dflt.content, "comments omitted"));

const untruncated = await injectWith({}, REF_415);
check("a long body is not truncated by default", has(untruncated.content, "body line 40"));
check("and says nothing about truncation", !has(untruncated.content, "truncated"));
check(
  "an issue with no comments gets no discussion section",
  !has(untruncated.content, "### Discussion"),
);

section("issue comments (config)");

const off = await injectWith({ includeComments: false }, REF_412);
check("includeComments:false injects no discussion", !has(off.content, "### Discussion"));
check("but still injects the body", has(off.content, "Body of issue 412."));
check("and does not ask gh for comments", !jsonFields(off.pi).includes("comments"), jsonFields(off.pi));

const keepHidden = await injectWith({ keepMinimized: true }, REF_412);
check("keepMinimized:true keeps what GitHub hides", has(keepHidden.content, "BUY CHEAP WATCHES"));

const noBots = await injectWith({ keepBots: false }, REF_412);
check("keepBots:false drops bot comments", !has(noBots.content, "dependabot[bot]"));
check(
  "and keeps the humans",
  has(noBots.content, "**@alice**") && has(noBots.content, "**@bob**"),
);

const truncated = await injectWith({ maxIssueChars: 120 }, REF_415);
check("maxIssueChars truncates the body", !has(truncated.content, "body line 40"));
check("keeping the head", has(truncated.content, "body line 1"));
check(
  "and reports it with the issue url",
  has(truncated.content, "Issue body truncated:") &&
    has(truncated.content, "https://github.com/acme/widgets/issues/415"),
  truncated.content,
);

const dropOldest = await injectWith({ maxComments: 2, dropComments: "oldest" }, REF_7);
check(
  "dropComments:oldest keeps the newest",
  has(dropOldest.content, "comment five") && has(dropOldest.content, "comment six"),
  dropOldest.content,
);
check("and drops the older ones", !has(dropOldest.content, "comment one"));
check("reporting the gap", has(dropOldest.content, "[… 4 of 6 comments omitted"));
check("with the marker above them", before(dropOldest.content, "omitted", "comment five"));

const dropNewest = await injectWith({ maxComments: 2, dropComments: "newest" }, REF_7);
check(
  "dropComments:newest keeps the oldest",
  has(dropNewest.content, "comment one") && has(dropNewest.content, "comment two"),
);
check("and drops the newer ones", !has(dropNewest.content, "comment six"));
check("with the marker below them", before(dropNewest.content, "comment two", "omitted"));

const dropMiddle = await injectWith({ maxComments: 3, dropComments: "middle" }, REF_7);
check(
  "dropComments:middle keeps both ends",
  has(dropMiddle.content, "comment one") &&
    has(dropMiddle.content, "comment two") &&
    has(dropMiddle.content, "comment six"),
  dropMiddle.content,
);
check(
  "and drops the middle",
  !has(dropMiddle.content, "comment three") && !has(dropMiddle.content, "comment four"),
);
check("counting the omission", has(dropMiddle.content, "[… 3 of 6 comments omitted"));
check(
  "with the marker at the gap",
  before(dropMiddle.content, "comment two", "omitted") &&
    before(dropMiddle.content, "omitted", "comment six"),
);

section("config robustness");
const broken = await injectWith("{ not json at all", REF_412);
check(
  "a malformed config falls back to defaults",
  has(broken.content, "### Discussion (4 comments)"),
  broken.content,
);

const badTypes = await injectWith({ maxComments: "lots", dropComments: "sideways" }, REF_7);
check(
  "wrong-typed keys fall back to their defaults",
  has(badTypes.content, "comment one") &&
    has(badTypes.content, "comment six") &&
    !has(badTypes.content, "omitted"),
  badTypes.content,
);

const negative = await injectWith({ maxIssueChars: -5 }, REF_415);
check("a negative number is rejected", has(negative.content, "body line 40"));

await rm(CONFIG_DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// alt+g
// ---------------------------------------------------------------------------

section("alt+g");
const oneRef = makeCtx(REPO, { editorText: "fix [#412 - Login crashes on empty password]" });
await pi.shortcuts.get("alt+g").handler(oneRef);
const webCall = pi.execCalls.find((c) => c.cmd === "gh" && c.args.includes("--web"));
check("a single reference opens directly", webCall != null);
check("opening the referenced issue", webCall?.args.includes("412"));
check(
  "and reports it",
  oneRef.ui.notifications.some((n) => has(n.text, "opened issue #412")),
);

const twoRefs = makeCtx(REPO, {
  editorText: "[#7 - Flaky retry] and [#415 - Dark mode contrast]",
  selectAnswer: (options) => options[1],
});
await pi.shortcuts.get("alt+g").handler(twoRefs);
check("several references prompt for one", twoRefs.ui.selectPrompts.length === 1);
check(
  "the picker lists both",
  twoRefs.ui.selectPrompts[0].options.length === 2 &&
    has(twoRefs.ui.selectPrompts[0].options[1], "#415"),
);

const noRef = makeCtx(REPO, { editorText: "nothing referenced", selectAnswer: undefined });
await pi.shortcuts.get("alt+g").handler(noRef);
check("with nothing referenced it offers the loaded issues", noRef.ui.selectPrompts.length === 1);
check(
  "over the full issue list",
  noRef.ui.selectPrompts[0].options.length === ISSUES.length,
  `${noRef.ui.selectPrompts[0]?.options.length}`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("Failures:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("SMOKE TEST OK");
