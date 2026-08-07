// Branch Context Extension
//
// Keeps LLM work scoped to the current git branch.
//
// On non-excluded branches, a scope context file lives at
// `<repo>/.pi/branches/<branch>.md` (path mirrors slashes: `feature/dark-mode`
// → `.pi/branches/feature/dark-mode.md`). The file's body is injected into the
// prompt as a `<branch-context>` block: WHAT THIS BRANCH IS ABOUT / NOT ABOUT,
// plus scope rules. Whether the file is git-tracked is the team's .gitignore
// decision — the extension never forces either.
//
// When the user asks for implementation work that is out of scope, the model
// calls the `branch_scope_choice` tool, which blocks on a `ctx.ui.select`
// dialog ("implement here" vs "create a separate branch"). Explicit user asks
// always win; read-only/trivial requests never trigger the dialog.
//
// Other behaviors:
//  - `/branch-scaffold` delegates to the agent: it researches the branch
//    (name, commits, diff), asks the user questions when the branch's intent
//    is ambiguous, and writes a proper context file.
//  - Pruning: hard-deletes `.pi/branches/<branch>.md` only when the branch has
//    neither a local ref nor a remote-tracking ref. Local git checks only (no
//    network), non-blocking, fired on session start and on branch change, at
//    most one pass per repo per process. Never prunes the current branch.
//  - Config (project `.pi/branch-context.json` merges over
//    `~/.pi/branch-context.json` over defaults):
//    { "enabled": true, "inject": "per-session"|"every-turn" (default
//      "per-session"), "maxWords": 300, "excludeBranches": [...],
//      "pruneOnStart": true, "staleThresholdCommits": 20, "suggestScaffold": true }
//  - Local-first: no accounts, no telemetry, no network calls.

import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, readdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_NAME = "branch_scope_choice";
const MESSAGE_TYPE = "branch-context";
const GIT_TIMEOUT_MS = 15_000;

// Block-internal scope rules (the plan's exact wording). The model must see
// these together with the ABOUT/NOT-ABOUT content of the context file.
const SCOPE_RULES =
	"Scope rules: explicit user asks ALWAYS win. For out-of-scope IMPLEMENTATION " +
	"work, call branch_scope_choice BEFORE implementing. Read-only/trivial " +
	"requests: never ask. If the user picks \"separate branch\", you decide the " +
	"base (main vs current HEAD, based on whether the work depends on this " +
	"branch's state), the branch name, and how to handle a dirty tree (commit or " +
	"stash with user awareness); commit the work and report clearly.";

const DEFAULT_CONFIG: Config = {
	enabled: true,
	inject: "per-session",
	maxWords: 300,
	excludeBranches: ["main", "develop", "release/*"],
	pruneOnStart: true,
	staleThresholdCommits: 20,
	suggestScaffold: true,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Config {
	enabled: boolean;
	inject: "per-session" | "every-turn";
	maxWords: number;
	excludeBranches: string[];
	pruneOnStart: boolean;
	staleThresholdCommits: number;
	suggestScaffold: boolean;
}

interface RepoBranch {
	repo: string; // `git rev-parse --show-toplevel`
	branch: string; // `git branch --show-current` (non-empty)
}

// ---------------------------------------------------------------------------
// Module state (reset per process; per-session sets reset on session_start)
// ---------------------------------------------------------------------------

const branchCache = new Map<string, string>(); // repo -> branch (mid-session checkout detection)
const pruneRan = new Set<string>(); // repo -> prune pass already done this process
const noticedMissing = new Set<string>(); // "repo\0branch" -> one-time scaffold notice
const injectedBranches = new Set<string>(); // "repo\0branch" -> per-session injection gate

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function applyConfigFile(merged: Config, filePath: string): void {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return; // missing file
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return; // malformed JSON: ignore silently
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return;
	const obj = data as Record<string, unknown>;
	if (typeof obj.enabled === "boolean") merged.enabled = obj.enabled;
	if (obj.inject === "per-session" || obj.inject === "every-turn") merged.inject = obj.inject;
	if (typeof obj.maxWords === "number" && Number.isFinite(obj.maxWords) && obj.maxWords >= 0) {
		merged.maxWords = Math.floor(obj.maxWords);
	}
	if (
		Array.isArray(obj.excludeBranches) &&
		obj.excludeBranches.every((x) => typeof x === "string")
	) {
		merged.excludeBranches = obj.excludeBranches as string[];
	}
	if (typeof obj.pruneOnStart === "boolean") merged.pruneOnStart = obj.pruneOnStart;
	if (
		typeof obj.staleThresholdCommits === "number" &&
		Number.isFinite(obj.staleThresholdCommits) &&
		obj.staleThresholdCommits >= 0
	) {
		merged.staleThresholdCommits = Math.floor(obj.staleThresholdCommits);
	}
	if (typeof obj.suggestScaffold === "boolean") merged.suggestScaffold = obj.suggestScaffold;
}

function loadConfig(cwd: string): Config {
	const merged: Config = { ...DEFAULT_CONFIG };
	// Global first (lowest precedence): ~/.pi/branch-context.json (plan-documented
	// path) and ~/.pi/agent/branch-context.json (pi config convention) both work.
	applyConfigFile(merged, join(homedir(), ".pi", "branch-context.json"));
	applyConfigFile(merged, join(getAgentDir(), "branch-context.json"));
	// Project-local overrides both.
	applyConfigFile(merged, join(cwd, CONFIG_DIR_NAME, "branch-context.json"));
	return merged;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function runGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<ExecResult> {
	return pi.exec(
		"git",
		["--no-optional-locks", "-c", "color.ui=false", ...args],
		{ cwd, timeout: GIT_TIMEOUT_MS },
	);
}

/** Resolve repo root + current branch. null for non-git cwd, detached HEAD, or unborn branch. */
async function resolveRepoBranch(pi: ExtensionAPI, cwd: string): Promise<RepoBranch | null> {
	const top = await runGit(pi, ["rev-parse", "--show-toplevel"], cwd);
	if (top.code !== 0) return null;
	const repo = top.stdout.trim();
	if (!repo) return null;
	const branchRes = await runGit(pi, ["branch", "--show-current"], repo);
	if (branchRes.code !== 0) return null;
	const branch = branchRes.stdout.trim();
	if (!branch) return null; // detached HEAD / unborn branch
	return { repo, branch };
}

async function shortHead(pi: ExtensionAPI, repo: string): Promise<string | null> {
	const res = await runGit(pi, ["rev-parse", "--short", "HEAD"], repo);
	return res.code === 0 ? res.stdout.trim() : null;
}

/** Commits on HEAD not reachable from tip. null when tip is not a valid rev. */
async function driftFrom(pi: ExtensionAPI, repo: string, tip: string): Promise<number | null> {
	if (!tip) return null;
	const res = await runGit(pi, ["rev-list", "--count", `${tip}..HEAD`], repo);
	if (res.code !== 0) return null;
	const n = parseInt(res.stdout.trim(), 10);
	return Number.isFinite(n) ? n : null;
}

/** Exact local-branch existence check (no pattern semantics: ref name equality). */
async function hasLocalRef(pi: ExtensionAPI, repo: string, branch: string): Promise<boolean> {
	const res = await runGit(pi, ["for-each-ref", "--format=%(refname)", "refs/heads/"], repo);
	if (res.code !== 0) return false;
	for (const line of res.stdout.split("\n")) {
		if (line.split("/").slice(2).join("/") === branch) return true;
	}
	return false;
}

/** Exact remote-tracking existence check across all remotes (local data, no network). */
async function hasRemoteTrackingRef(pi: ExtensionAPI, repo: string, branch: string): Promise<boolean> {
	const res = await runGit(pi, ["for-each-ref", "--format=%(refname)", "refs/remotes/"], repo);
	if (res.code !== 0) return false;
	for (const line of res.stdout.split("\n")) {
		// refs/remotes/<remote>/<name...> — compare everything after the remote.
		if (line.split("/").slice(3).join("/") === branch) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Branch-name matching (tiny glob: `*` = any chars incl. `/`, `?` = one char)
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
	let out = "^";
	for (let i = 0; i < pattern.length; i += 1) {
		const ch = pattern[i]!;
		if (ch === "*") out += ".*";
		else if (ch === "?") out += ".";
		else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	out += "$";
	return new RegExp(out);
}

function isExcludedBranch(branch: string, patterns: string[]): boolean {
	return patterns.some((p) => globToRegExp(p).test(branch));
}

// ---------------------------------------------------------------------------
// Context file parsing / block building
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
	if (!content.startsWith("---")) return { meta: {}, body: content };
	const firstNl = content.indexOf("\n");
	if (firstNl === -1) return { meta: {}, body: content };
	const close = content.indexOf("\n---", firstNl + 1);
	if (close === -1) return { meta: {}, body: content };
	const meta: Record<string, string> = {};
	for (const line of content.slice(3, close).split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	const body = content.slice(close + 4).replace(/^\n+/, "");
	return { meta, body };
}

function wordCount(text: string): number {
	const t = text.trim();
	return t === "" ? 0 : t.split(/\s+/).length;
}

function truncateWords(text: string, maxWords: number): string {
	if (maxWords <= 0 || wordCount(text) <= maxWords) return text;
	const kept = text.trim().split(/\s+/).slice(0, maxWords).join(" ");
	return `${kept}\n\n…(truncated)`;
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

const FRAMING_LINE =
	"This branch's scope context file is injected automatically — use it as given " +
	"instead of asking the user to restate it.";

function buildContextBlock(opts: {
	branch: string;
	relFile: string;
	written: string | undefined;
	body: string;
	staleNote: string | undefined;
}): string {
	const attrs = [`branch="${escapeAttr(opts.branch)}"`, `file="${escapeAttr(opts.relFile)}"`];
	if (opts.written) attrs.push(`written="${escapeAttr(opts.written)}"`);
	const stale = opts.staleNote ? `\n\n${opts.staleNote}` : "";
	return [
		`<branch-context ${attrs.join(" ")}>`,
		FRAMING_LINE,
		"",
		opts.body.trim(),
		"",
		SCOPE_RULES,
		stale,
		"</branch-context>",
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Active-tool sync (keep the prompt lean: tool active only with a context file)
// ---------------------------------------------------------------------------

function syncTool(pi: ExtensionAPI, active: boolean): void {
	const current = pi.getActiveTools();
	const has = current.includes(TOOL_NAME);
	if (active && !has) pi.setActiveTools([...current, TOOL_NAME]);
	else if (!active && has) pi.setActiveTools(current.filter((n) => n !== TOOL_NAME));
}

// ---------------------------------------------------------------------------
// Session-state helpers
// ---------------------------------------------------------------------------

function branchKey(repo: string, branch: string): string {
	return `${repo}\u0000${branch}`;
}

/** True when this session already carries a branch-context message for repo+branch (covers resume). */
function sessionHasContextMessage(ctx: { sessionManager: { getEntries(): unknown[] } }, key: string): boolean {
	try {
		for (const entry of ctx.sessionManager.getEntries() as Array<{
			type?: string;
			customType?: string;
			details?: { repo?: string; branch?: string };
		}>) {
			if (entry.type === "custom_message" && entry.customType === MESSAGE_TYPE) {
				const d = entry.details;
				if (d && typeof d.repo === "string" && typeof d.branch === "string") {
					if (branchKey(d.repo, d.branch) === key) return true;
				}
			}
		}
	} catch {
		return false;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

async function pruneBranchContexts(pi: ExtensionAPI, repo: string, currentBranch: string): Promise<void> {
	if (pruneRan.has(repo)) return;
	pruneRan.add(repo);

	const branchesDir = join(repo, CONFIG_DIR_NAME, "branches");
	let entries;
	try {
		// recursive: slash branches live in subdirectories (feature/dark-mode.md → feature/).
		entries = await readdir(branchesDir, { recursive: true, withFileTypes: true });
	} catch {
		return; // no branches dir yet
	}
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const rel = relative(branchesDir, join(entry.parentPath ?? branchesDir, entry.name));
		if (!rel.endsWith(".md")) continue;
		if (rel.startsWith(".")) continue; // dotfiles (e.g. .prune.log has no .md; defense in depth)
		const branch = rel.slice(0, -3);
		if (branch === currentBranch || branch === "main") continue; // never current, never main.md
		const [local, remote] = await Promise.all([
			hasLocalRef(pi, repo, branch),
			hasRemoteTrackingRef(pi, repo, branch),
		]);
		if (local || remote) continue;
		const filePath = join(branchesDir, rel);
		await unlink(filePath).catch(() => {});
		await appendFile(
			join(branchesDir, ".prune.log"),
			`${new Date().toISOString()} deleted ${branch} (no local or remote-tracking ref)\n`,
			"utf8",
		).catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Scaffold helpers (/branch-scaffold)
// ---------------------------------------------------------------------------

// Shared structure template: /branch-scaffold's steer prompt and the
// suggestScaffold guidance both embed this exact block, so the spec never drifts.
const SCAFFOLD_TEMPLATE = (branch: string, today: string, tip: string) =>
	`---\nbranch: ${branch}\nwritten_at: ${today}\ntip: ${tip}\ngenerated: true\n---\n\n` +
	"WHAT THIS BRANCH IS ABOUT:\n<concise statement of this branch's purpose and scope>\n\n" +
	"WHAT THIS BRANCH IS NOT ABOUT:\n<what is deliberately out of scope — other areas/features this branch does NOT touch>";

async function findBase(pi: ExtensionAPI, repo: string): Promise<string | null> {
	for (const candidate of ["main", "origin/main"]) {
		const mb = await runGit(pi, ["merge-base", "HEAD", candidate], repo);
		if (mb.code === 0 && mb.stdout.trim() !== "") return mb.stdout.trim();
	}
	// Fallback: a few commits back on the branch itself.
	const prev = await runGit(pi, ["rev-parse", "--verify", "HEAD~10"], repo);
	if (prev.code === 0) return prev.stdout.trim();
	return null;
}

/**
 * Agent guidance embedded in the one-time notice when suggestScaffold is on.
 * Tells the model to proactively offer creating the missing context file and,
 * on agreement, write it itself — same spec as /branch-scaffold, so the
 * outcome is identical to running the command (pi has no model→command
 * dispatch, so the model performs the scaffold guided by this text).
 */
async function buildScaffoldGuidance(
	pi: ExtensionAPI,
	repo: string,
	branch: string,
	relFile: string,
): Promise<string> {
	const base = await findBase(pi, repo);
	const tip = await shortHead(pi, repo);
	const today = new Date().toISOString().slice(0, 10);
	const logCmd = base ? `git log --oneline ${base}..HEAD` : "git log --oneline -20";
	const diffCmd = base ? `git diff --stat ${base}...HEAD` : "git diff --stat HEAD~10...HEAD";

	return (
		"[agent guidance — offer to create the branch-context file]\n" +
		`Whenever the user starts work on this branch, briefly suggest creating the context file before writing code — e.g. "I noticed there's no branch-context file for this branch yet — want me to create one?"\n` +
		"Do NOT read the branch-context extension source or search for how this file should look — everything you need is described here.\n" +
		`If the user agrees, write "${relFile}" yourself with EXACTLY this structure:\n` +
		SCAFFOLD_TEMPLATE(branch, today, tip ?? "unknown") +
		"\n" +
		"How to write it well:\n" +
		`1. Study the branch: the branch name, \`${logCmd}\` (or the last 20 commits of HEAD when no base exists), and \`${diffCmd}\` (base = merge-base of HEAD with main/origin/main, or HEAD~10 when no main exists). If the branch has no commits beyond base, ask the user what it is about.\n` +
		"2. Infer the branch's intent from the name, commits, and diff. If anything is genuinely ambiguous, ASK the user questions first — do not guess. If the intent is already clear (branch name or the user's request), write the file without extra questions.\n" +
		"3. Synthesize intent; do NOT paste the commit log or diff stat verbatim. Keep it concise (a few sentences per section, well under 300 words).\n" +
		"4. After writing, tell the user what you wrote and remind them to review it for secrets (it is generated from git history)."
	);
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// -----------------------------------------------------------------------
	// Tool: branch_scope_choice — blocking user choice for out-of-scope work
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: TOOL_NAME,
		label: "Branch Scope Choice",
		description:
			"Ask the user whether out-of-scope implementation work should be done on the " +
			"current branch or on a separate branch. Use ONLY when the user requests " +
			"implementation work that is out of scope for the current branch's context " +
			"file — never for read-only/trivial requests, never for explicit user asks.",
		promptSnippet:
			"Ask the user to choose: implement out-of-scope work on this branch or on a separate branch",
		promptGuidelines: [
			"Use branch_scope_choice when the user asks for implementation work that is out of scope for the current branch (per the branch-context block).",
			"Never call branch_scope_choice for read-only or trivial requests, and never when the user explicitly asks to work on the current branch — explicit user asks always win.",
		],
		parameters: Type.Object({
			branch: Type.String({ description: "Current git branch name" }),
			task: Type.String({ description: "Short description of the out-of-scope implementation work requested" }),
			suggestedBranch: Type.Optional(
				Type.String({ description: "Optional suggested name for the separate branch" }),
			),
		}),
		executionMode: "sequential", // blocks on user input; never parallel with other tools
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text:
								`Cannot show the choice dialog: no interactive UI in ${ctx.mode} mode. ` +
								`Defaulting to the current branch — do NOT create a separate branch without an explicit user decision.`,
						},
					],
					details: { choice: "no-ui-default-here", branch: params.branch, task: params.task, mode: ctx.mode },
				};
			}

			const options = [
				`Implement it here on ${params.branch}`,
				"Create a separate branch for this",
			];
			const choice = await ctx.ui.select("Out-of-scope request", options);

			if (choice === undefined) {
				return {
					content: [
						{
							type: "text",
							text:
								"User dismissed the dialog without choosing. Do not silently implement " +
								"out-of-scope work — ask the user again before proceeding, or pause and wait for an explicit decision.",
						},
					],
					details: { choice: "cancelled", branch: params.branch, task: params.task },
				};
			}

			const separate = choice === options[1];
			const text = separate
				? `User chose: ${choice}. Create the work on a separate branch: you decide the ` +
				  `base (main vs current HEAD, based on whether the work depends on this branch's ` +
				  `state), the branch name, and how to handle a dirty tree (commit or stash with ` +
				  `user awareness); commit the work and report clearly.`
				: `User chose: ${choice}. Implement the work on the current branch as requested.`;
			return {
				content: [{ type: "text", text }],
				details: {
					choice: separate ? "separate-branch" : "implement-here",
					branch: params.branch,
					task: params.task,
					suggestedBranch: params.suggestedBranch ?? null,
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// session_start: reset per-session state + fire-and-forget prune
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		noticedMissing.clear();
		injectedBranches.clear();

		const config = loadConfig(ctx.cwd);
		if (!config.enabled) return;
		if (!ctx.isProjectTrusted()) return;

		const info = await resolveRepoBranch(pi, ctx.cwd);
		if (!info) return;
		branchCache.set(info.repo, info.branch);

		// Tool state for the common case (re-checked on every prompt anyway, so a
		// mid-session checkout is still caught there).
		const excluded = isExcludedBranch(info.branch, config.excludeBranches);
		const hasContext =
			!excluded &&
			existsSync(join(info.repo, CONFIG_DIR_NAME, "branches", `${info.branch}.md`));
		syncTool(pi, hasContext);

		if (config.pruneOnStart) {
			// Non-blocking: never wait for pruning at startup.
			void pruneBranchContexts(pi, info.repo, info.branch).catch(() => {});
		}
	});

	// -----------------------------------------------------------------------
	// before_agent_start: inject branch context + keep the tool set in sync
	// -----------------------------------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!ctx.isProjectTrusted()) return;

			const config = loadConfig(ctx.cwd);
			if (!config.enabled) return;

			const info = await resolveRepoBranch(pi, ctx.cwd);
			if (!info) return; // non-git / detached / unborn — nothing to scope
			const { repo, branch } = info;

			// Mid-session checkout detection → branch-change prune (fire-and-forget).
			const cached = branchCache.get(repo);
			if (cached !== branch) {
				branchCache.set(repo, branch);
				if (config.pruneOnStart) {
					void pruneBranchContexts(pi, repo, branch).catch(() => {});
				}
			}

			// Excluded branch → no injection, no tool.
			if (isExcludedBranch(branch, config.excludeBranches)) {
				syncTool(pi, false);
				return;
			}

			const relFile = join(CONFIG_DIR_NAME, "branches", `${branch}.md`);
			const filePath = join(repo, CONFIG_DIR_NAME, "branches", `${branch}.md`);

			if (!existsSync(filePath)) {
				syncTool(pi, false);
				const key = branchKey(repo, branch);
				if (!noticedMissing.has(key) && !sessionHasContextMessage(ctx, key)) {
					noticedMissing.add(key);
					const userLine =
						`No branch-context file exists for branch "${branch}". ` +
						`Run /branch-scaffold to have the agent write one, or create ${relFile} yourself.`;
					const content = config.suggestScaffold
						? `${userLine}\n\n${await buildScaffoldGuidance(pi, repo, branch, relFile)}`
						: userLine;
					return {
						message: {
							customType: MESSAGE_TYPE,
							content,
							display: true,
							details: { repo, branch, missing: true, suggestScaffold: config.suggestScaffold },
						},
					};
				}
				return;
			}

			const content = await readFile(filePath, "utf8").catch(() => null);
			if (content === null) return; // read failure — stay silent
			const { meta, body } = parseFrontmatter(content);
			const truncatedBody = truncateWords(body, config.maxWords);

			// Stale flag: only when the tip drifted beyond the threshold.
			let staleNote: string | undefined;
			const tip = meta.tip;
			if (config.staleThresholdCommits > 0 && tip) {
				const drift = await driftFrom(pi, repo, tip);
				if (drift !== null && drift > config.staleThresholdCommits) {
					const head = await shortHead(pi, repo);
					staleNote = `[may be stale: written at ${tip}, HEAD now ${head ?? "?"}]`;
				}
			}

			const block = buildContextBlock({
				branch,
				relFile,
				written: meta.written_at ?? meta.written,
				body: truncatedBody,
				staleNote,
			});

			// Tool activation takes effect from the rebuilt base prompt; the block
			// below names the tool so the model can call it even if activation lags
			// one turn after a mid-session branch switch.
			syncTool(pi, true);

			if (config.inject === "every-turn") {
				return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
			}

			// per-session (default): inject once per session per branch, dedupe
			// against persisted session entries (resume / reload).
			const key = branchKey(repo, branch);
			if (!injectedBranches.has(key) && !sessionHasContextMessage(ctx, key)) {
				injectedBranches.add(key);
				return {
					message: {
						customType: MESSAGE_TYPE,
						content: block,
						display: true,
						details: { repo, branch },
					},
				};
			}
			return undefined;
		} catch (err) {
			// Never break the agent loop because of this extension.
			console.error("[branch-context] before_agent_start failed:", err);
			return undefined;
		}
	});

	// -----------------------------------------------------------------------
	// Command: /branch-scaffold
	// -----------------------------------------------------------------------

	pi.registerCommand("branch-scaffold", {
		description:
			"Have the agent research this branch and write the branch-context file (.pi/branches/<branch>.md)",
		handler: async (_args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("branch-context: project not trusted — refusing to write project files", "error");
				return;
			}
			const config = loadConfig(ctx.cwd);
			if (!config.enabled) {
				ctx.ui.notify("branch-context: disabled in config", "warning");
				return;
			}
			const info = await resolveRepoBranch(pi, ctx.cwd);
			if (!info) {
				ctx.ui.notify("branch-context: not a git repo, or no current branch (detached/unborn)", "error");
				return;
			}
			const { repo, branch } = info;

			// Research inputs for the agent: base (merge-base with main/origin/main, or a
			// few commits back), tip (short HEAD hash), and the target relative path. The
			// agent runs the git log/diff itself; we only resolve what it needs for the
			// frontmatter and to know where to write.
			const base = await findBase(pi, repo);
			const tip = await shortHead(pi, repo);
			const relFile = join(CONFIG_DIR_NAME, "branches", `${branch}.md`);
			const today = new Date().toISOString().slice(0, 10);
			const logCmd = base ? `git log --oneline ${base}..HEAD` : "git log --oneline -20";
			const diffCmd = base ? `git diff --stat ${base}...HEAD` : "git diff --stat HEAD~10...HEAD";

			const prompt = [
				`The user ran /branch-scaffold — create the branch-context file for branch "${branch}".`,
				"",
				`Write "${relFile}" in this repo with EXACTLY this structure:`,
				"```",
				SCAFFOLD_TEMPLATE(branch, today, tip ?? "unknown"),
				"```",
				"How to write it well:",
				`1. Study the branch: the branch name, \`${logCmd}\` (or the last 20 commits of HEAD when no base exists), and \`${diffCmd}\` (base = merge-base of HEAD with main/origin/main).`,
				"2. Infer the branch's intent from the name, commits, and diff. If anything is genuinely ambiguous, ASK the user questions first — do not guess.",
				"3. Synthesize intent; do NOT paste the commit log or diff stat verbatim. The file is injected into every prompt on this branch, so keep it concise (a few sentences per section, well under 300 words).",
				"4. Write the file, then report what you wrote and remind the user to review it for secrets (it is generated from git history).",
			].join("\n");

			// Hand off to the agent: it researches the branch (may ask clarifying
			// questions) and writes the file. The agent's write tool creates the branch
			// subdirectory (e.g. .pi/branches/feat/ for feat/mobile-support.md), so no
			// mkdir is needed here.
			//
			// Note: use pi.sendUserMessage, not ctx.sendUserMessage. Extension
			// event/command contexts declare sendUserMessage in ExtensionContextActions
			// but do not wire it at runtime (runner.createContext() lacks it; only
			// ReplacedSessionContext gets it). pi.* IS wired (loader → agent-session),
			// matching pi's own /ask /steer /followup example commands. deliverAs
			// "followUp" is safe when idle (ignored) and when streaming (queued).
			ctx.ui.notify(
				`branch-context: generating ${relFile} — the agent will research the branch and may ask questions`,
				"info",
			);
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		},
	});
}
