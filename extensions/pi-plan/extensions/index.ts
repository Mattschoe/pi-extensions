// Pi Plan — plan mode, accept-edits mode, and plan execution tracking.
//
// Derived from `pi-pledit@1.0.1` (npm, published 2026-05-04) by jaroslawjanas,
// MIT licensed. See LICENSE and README.md for the full attribution.
//
// Three previously separate pieces live here as one package, because none of
// them stood alone: the permission-mode cycle wrote plan files that only the
// tracking half could execute, and the tracking half registered the command
// the mode cycle handed off to.
//
//  - Permission modes: a shortcut cycles default → accept edits → plan.
//    Plan mode blocks write/edit and gates bash to a read-only allowlist;
//    accept-edits auto-approves everything except configured unsafe patterns.
//  - Plan capture: when a plan-mode turn ends, the assistant's final message
//    is saved to `.pi/plans/<slug>-<timestamp>.md` and a dialog offers four
//    ways forward, including a handoff to a fresh chat.
//  - Execution tracking: numbered steps under "## Plan" become a todo widget,
//    `[DONE:n]` markers tick them off, and a "## Done When" section is
//    replayed as a verification prompt once every step is complete.
//
// Config (project `<cwd>/.pi/pledit.json`, then global
// `<agent-dir>/pledit.json` which overrides it — the filename is kept from
// upstream so existing configs keep working):
//   { "shortcut": "shift+tab", "readonlyBash": [...], "unsafePatterns": [...] }

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
} from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type Mode = "default" | "plan" | "acceptEdits";

const MODE_CYCLE: Mode[] = ["default", "acceptEdits", "plan"];

const DEFAULT_SHORTCUT = "f6";

const CONFIG_FILENAME = "pledit.json";

interface PlanConfig {
	shortcut?: string;
	readonlyBash?: string[];
	unsafePatterns?: string[];
}

const DEFAULT_READONLY_BASH = [
	"ls ", "find ", "grep ", "rg ", "cat ", "head ", "tail ", "echo ", "pwd ", "which ", "wc ",
	"git status", "git diff", "git log", "git branch", "git stash list", "git show",
];

// Commands that still prompt in accept-edits mode. Deliberately broader than
// the upstream fork's `["rm -rf"]`: auto-running `sudo` on someone else's
// machine is not a reasonable default. Override via `unsafePatterns`.
const DEFAULT_UNSAFE_PATTERNS = [
	"rm -rf",
	"sudo",
	"chmod 777",
	"docker system prune",
];

function readJson<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function applyConfig(target: Required<PlanConfig>, source: PlanConfig | undefined): void {
	if (!source) return;
	if (source.shortcut) target.shortcut = source.shortcut;
	if (source.readonlyBash) target.readonlyBash = source.readonlyBash;
	if (source.unsafePatterns) target.unsafePatterns = source.unsafePatterns;
}

function resolveConfig(cwd: string): Required<PlanConfig> {
	const config: Required<PlanConfig> = {
		shortcut: DEFAULT_SHORTCUT,
		readonlyBash: DEFAULT_READONLY_BASH,
		unsafePatterns: DEFAULT_UNSAFE_PATTERNS,
	};
	// Project config first, then global — global wins, matching upstream.
	applyConfig(config, readJson<PlanConfig>(path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME)));
	applyConfig(config, readJson<PlanConfig>(path.join(getAgentDir(), CONFIG_FILENAME)));
	return config;
}

// ---------------------------------------------------------------------------
// Bash classification
// ---------------------------------------------------------------------------

// Peel off wrappers and leading env assignments so `FOO=1 timeout 5 rm -rf /`
// is classified on `rm -rf /`, not on `FOO=1`.
function stripBashWrappers(command: string): string {
	let trimmed = command.trim();
	let changed = true;
	while (changed) {
		changed = false;
		for (const wrapper of ["timeout ", "nice ", "nohup "]) {
			if (trimmed.startsWith(wrapper)) {
				trimmed = trimmed.slice(wrapper.length).trimStart();
				changed = true;
			}
		}
		const envMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/);
		if (envMatch) {
			trimmed = trimmed.slice(envMatch[0].length);
			changed = true;
		}
	}
	return trimmed;
}

function isUnsafe(command: string, patterns: string[]): boolean {
	const trimmed = stripBashWrappers(command);
	return patterns.some((p) => trimmed.includes(p));
}

function isReadonlyBash(command: string, config: Required<PlanConfig>): boolean {
	if (isUnsafe(command, config.unsafePatterns)) return false;
	const trimmed = stripBashWrappers(command);
	return config.readonlyBash.some((p) => trimmed.startsWith(p));
}

// ---------------------------------------------------------------------------
// Message helpers
//
// Structurally typed rather than importing the message types, so the package
// peer-depends only on pi-coding-agent and pi-tui.
// ---------------------------------------------------------------------------

interface TextBlock {
	type: "text";
	text: string;
}

interface AssistantLike {
	role: string;
	content: readonly unknown[];
}

function isAssistantMessage(message: unknown): message is AssistantLike {
	if (typeof message !== "object" || message === null) return false;
	const m = message as { role?: unknown; content?: unknown };
	return m.role === "assistant" && Array.isArray(m.content);
}

function isTextBlock(block: unknown): block is TextBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "text" &&
		typeof (block as { text?: unknown }).text === "string"
	);
}

function getTextContent(message: AssistantLike): string {
	return message.content.filter(isTextBlock).map((b) => b.text).join("\n");
}

// ---------------------------------------------------------------------------
// Plan text parsing
// ---------------------------------------------------------------------------

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

function slugify(text: string, maxLen = 50): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, maxLen)
		.replace(/-$/, "");
}

// Generic section headings that are not plan titles (template sections,
// legacy wrappers). Skipped when searching for a name.
const GENERIC_PLAN_HEADING =
	/^(plan|summary|findings?|overview|introduction|background|context|approach|implementation|implementation\s+plan|steps?|implementation\s+steps|step-by-step\s+implementation|risks|testing|testing\s+strategy|done\s+when|verification|conclusion|next\s+steps|rationale|design|details|detailed\s+changes.*|architecture|files?\s+to\s+(read|modify|create)|files\s+changed|key\s+design\s+decisions|what\s+changes.*|step\s*\d+.*|\d+[.)]\s*.*)$/i;

// First non-generic markdown heading; strips "Plan: / Implementation Plan: /
// Summary:" style prefixes. Returns "plan" when no usable title exists.
function extractPlanTitle(content: string): string {
	for (const match of content.matchAll(/^\s*#{1,3}\s+(.+)$/gm)) {
		const title = match[1]!
			.trim()
			.replace(
				/^(plan|implementation\s*plan|updated\s*implementation\s*plan|summary)\s*[:—-]\s*/i,
				"",
			)
			.trim();
		if (title.length === 0) continue;
		if (GENERIC_PLAN_HEADING.test(title)) continue;
		return title;
	}
	return "plan";
}

function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // bold/italic
		.replace(/`([^`]+)`/g, "$1") // inline code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	// Accept the bare "Plan:" label (legacy) or a markdown heading like "## Plan".
	const headerMatch = message.match(/^\s*#{0,3}\s*Plan:?\s*\n/im);
	if (!headerMatch || headerMatch.index === undefined) return items;

	let planSection = message.slice(headerMatch.index + headerMatch[0].length);
	// Stop at the next markdown heading so numbered items under "## Done When"
	// (or any later section) can't leak in as todos.
	const nextHeading = planSection.match(/^\s*##\s/m);
	if (nextHeading && nextHeading.index !== undefined) {
		planSection = planSection.slice(0, nextHeading.index);
	}

	for (const match of planSection.matchAll(/^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm)) {
		const text = match[2]!.trim().replace(/\*{1,2}$/, "").trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}

// Body of a "## Done When" / "**Done When:**" / "Done When:" section, up to the
// next markdown heading.
function extractDoneWhenText(message: string): string | undefined {
	const patterns = [
		/##\s+Done\s+When\s*\n/i,
		/\*{1,2}Done\s+When:?\*{1,2}\s*\n/i,
		/^Done\s+When:\s*\n/im,
	];

	for (const pattern of patterns) {
		const match = message.match(pattern);
		if (!match || match.index === undefined) continue;

		let body = message.slice(match.index + match[0].length);
		const nextHeading = body.match(/^##?\s/m);
		if (nextHeading && nextHeading.index !== undefined) {
			body = body.slice(0, nextHeading.index);
		}

		body = body.trim();
		if (body.length > 0) return body;
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Plan files on disk
// ---------------------------------------------------------------------------

interface PlanEntry {
	filename: string;
	filepath: string;
	title: string;
	date: string;
	body: string;
}

function getPlansDir(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "plans");
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function buildPlanFile(content: string, meta: Record<string, unknown>): string {
	const frontmatter = Object.entries(meta)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");

	// No "# Plan" wrapper — the plan content carries its own title heading.
	return `---\n${frontmatter}\n---\n\n${content.trim()}\n`;
}

function parseFrontmatter(content: string): string {
	const match = content.match(/^---\n[\s\S]*?\n---\n\n([\s\S]*)$/);
	return match ? match[1]! : content;
}

// Collision-safe plan filename: `<slug>-<ts>.md`, then `<slug>-<ts>-2.md`, …
// The timestamp stays in the name so /plans can sort by date and
// resolvePlanFilepath can survive renames.
function uniquePlanFilename(dir: string, slug: string, ts: string): string {
	let name = `${slug}-${ts}.md`;
	let counter = 1;
	while (fs.existsSync(path.join(dir, name))) {
		counter++;
		name = `${slug}-${ts}-${counter}.md`;
	}
	return name;
}

// Single write point for plan files. Named from the plan's own title heading,
// which is why no rename pass is needed after the fact.
function savePlan(cwd: string, planText: string, sessionFile: string | undefined): string {
	const plansDir = getPlansDir(cwd);
	fs.mkdirSync(plansDir, { recursive: true });

	const ts = timestamp();
	const slug = slugify(extractPlanTitle(planText));
	const filename = slug && slug !== "plan" ? uniquePlanFilename(plansDir, slug, ts) : `plan-${ts}.md`;
	const filepath = path.join(plansDir, filename);

	fs.writeFileSync(
		filepath,
		buildPlanFile(planText, {
			created: new Date().toISOString(),
			mode: "plan",
			session: sessionFile || "ephemeral",
		}),
		"utf-8",
	);
	return filepath;
}

function extractDate(filename: string): string {
	const match = filename.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
	return match ? match[1]! : timestamp();
}

function listPlans(cwd: string): PlanEntry[] {
	const dir = getPlansDir(cwd);
	if (!fs.existsSync(dir)) return [];

	const entries: PlanEntry[] = [];
	for (const filename of fs.readdirSync(dir)) {
		if (!filename.endsWith(".md")) continue;
		const filepath = path.join(dir, filename);
		let content: string;
		try {
			content = fs.readFileSync(filepath, "utf-8");
		} catch {
			continue;
		}
		entries.push({
			filename,
			filepath,
			title: extractPlanTitle(content),
			date: extractDate(filename),
			body: parseFrontmatter(content),
		});
	}
	return entries.sort((a, b) => b.date.localeCompare(a.date)); // newest first
}

// Resolve a plan file path from a command argument, with fallbacks for cwd
// ambiguity and for plans referenced by an older filename.
function resolvePlanFilepath(
	arg: string,
	cwd: string,
	sessionCwd: string | undefined,
): string | undefined {
	const candidates: string[] = [];
	if (path.isAbsolute(arg)) {
		candidates.push(arg);
	} else {
		candidates.push(path.resolve(cwd, arg));
		if (sessionCwd && sessionCwd !== cwd) candidates.push(path.resolve(sessionCwd, arg));
	}

	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			// ignore
		}
	}

	// Fallback: match by the date component — survives renames and cwd confusion.
	const tsMatch = arg.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
	if (!tsMatch) return undefined;

	const dirs = new Set<string>([getPlansDir(cwd)]);
	if (sessionCwd) dirs.add(getPlansDir(sessionCwd));
	for (const dir of dirs) {
		try {
			for (const f of fs.readdirSync(dir)) {
				if (f.includes(tsMatch[1]!)) {
					const p = path.join(dir, f);
					if (fs.existsSync(p)) return p;
				}
			}
		} catch {
			// ignore
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// External editor
// ---------------------------------------------------------------------------

// $VISUAL, then $EDITOR, then vi. Both may carry arguments ("code -w").
function resolveEditor(): { command: string; args: string[] } {
	const raw = (process.env.VISUAL || process.env.EDITOR || "vi").trim();
	const parts = raw.split(/\s+/).filter(Boolean);
	return { command: parts[0] || "vi", args: parts.slice(1) };
}

function openPlanInEditor(filepath: string, ctx: ExtensionContext): Promise<void> {
	const { command, args } = resolveEditor();
	return ctx.ui.custom<void>((tui, _theme, _kb, done) => {
		tui.stop();
		const child = spawn(command, [...args, filepath], { stdio: "inherit" });
		const finish = (failed: boolean) => {
			tui.start();
			tui.requestRender(true);
			if (failed) ctx.ui.notify(`Could not launch editor: ${command}`, "error");
			done();
		};
		child.on("close", () => finish(false));
		child.on("error", () => finish(true));
		return { render: () => [], invalidate: () => {}, handleInput: () => {} };
	});
}

// ---------------------------------------------------------------------------
// Plan browser TUI
// ---------------------------------------------------------------------------

type PlansResult =
	| { action: "select"; path: string }
	| { action: "preview"; path: string }
	| { action: "cancel" };

async function showPlansOverlay(ctx: ExtensionContext): Promise<PlansResult> {
	const plans = listPlans(ctx.cwd);

	if (plans.length === 0) {
		ctx.ui.notify(`No plans found in ${CONFIG_DIR_NAME}/plans/`, "info");
		return { action: "cancel" };
	}

	const selectItems: SelectItem[] = plans.map((p) => ({
		value: p.filepath,
		label: p.title,
		description: p.date.replace("T", " ").replace(/-/g, (c, i) => (i > 10 ? ":" : c)),
	}));

	return await ctx.ui.custom<PlansResult>((tui, theme, _kb, done) => {
		let currentItem: SelectItem = selectItems[0]!;

		const selectList = new SelectList(selectItems, Math.min(selectItems.length + 4, 20), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});

		selectList.onSelect = (item) => done({ action: "select", path: item.value });
		selectList.onCancel = () => done({ action: "cancel" });
		selectList.onSelectionChange = (item) => {
			currentItem = item;
		};

		const headerLines = [
			theme.fg("accent", theme.bold("Plans")),
			theme.fg("dim", "↑↓ navigate  •  enter select  •  → open in editor  •  ← esc close"),
			theme.fg("dim", `${plans.length} plans loaded`),
			"",
		];

		return {
			render: (w: number) => {
				const container = new Container();
				container.addChild(
					new (class {
						render(_w: number) {
							return headerLines;
						}
						invalidate() {}
					})(),
				);
				container.addChild(selectList);
				return container.render(w);
			},

			invalidate: () => {
				selectList.invalidate();
			},

			handleInput: (data: string) => {
				if (matchesKey(data, Key.left)) {
					done({ action: "cancel" });
				} else if (matchesKey(data, Key.right) || matchesKey(data, Key.shift("enter"))) {
					if (currentItem) done({ action: "preview", path: currentItem.value });
				} else {
					selectList.handleInput(data);
					tui.requestRender();
				}
			},
		};
	});
}

async function showPlansTui(
	ctx: ExtensionContext,
	onSelect: (planPath: string) => void | Promise<void>,
): Promise<void> {
	while (true) {
		const result = await showPlansOverlay(ctx);

		if (result.action === "cancel") return;

		if (result.action === "select") {
			await onSelect(result.path);
			return;
		}

		// "preview" — open the plan in $EDITOR, then return to the list.
		const plan = listPlans(ctx.cwd).find((p) => p.filepath === result.path);
		if (plan) await openPlanInEditor(plan.filepath, ctx);
	}
}

// ---------------------------------------------------------------------------
// Mode labels
// ---------------------------------------------------------------------------

function statusLabel(mode: Mode): string {
	// No indicator shown in default mode
	if (mode === "plan") return "∥∥ plan mode";
	if (mode === "acceptEdits") return "⏵⏵ accept edits";
	return "";
}

function notifyLabel(mode: Mode, config: Required<PlanConfig>): string {
	if (mode === "plan") return "Plan mode — read only";
	if (mode === "acceptEdits") {
		return `Accept edits — auto-approved except: ${config.unsafePatterns.join(", ")}`;
	}
	return "Default mode — prompts before changes";
}

const PLAN_MODE_PROMPT =
	`\n\n[PLAN MODE ACTIVE] You are in PLAN MODE. The write and edit tools are DISABLED. bash is restricted to read-only commands.` +
	`\n- Read files, search the codebase, and analyze thoroughly. Ask clarifying questions when requirements are ambiguous.` +
	`\n- Then produce a structured implementation plan as your final response.` +
	`\n- The plan will be executed in a FRESH chat with zero memory of this session. Write it as a self-contained snapshot of the idea — NOT a summary of this conversation. Never write "we discussed", "you asked", "as I said", or "per your choice"; if a decision matters, state it as a fact with its reason.` +
	`\n- Begin your response with a title heading: "# <Short descriptive title>" (a few words, like a commit message). Nothing before it — the title names the plan file.` +
	`\n- Structure, in order:` +
	`\n  - "## Context" — why this plan exists: the goal, the problem, and any decisions already made.` +
	`\n  - "## Files to Read" — exact file paths the executor should open first to get oriented.` +
	`\n  - "## Files to Modify" — each file with what changes.` +
	`\n  - "## Files to Create" — each new file with its purpose.` +
	`\n  - "## Plan" — numbered implementation steps, each concrete and executable without asking the user.` +
	`\n  - "## Risks"` +
	`\n  - "## Testing Strategy"` +
	`\n  - "## Done When" — verifiable success criteria. Each one specific and checkable; "src/config.ts contains a retryTimeout field set to 5000", not "the config is updated properly".` +
	`\n- Do NOT use write or edit. They are blocked.`;

const ACCEPT_EDITS_PROMPT =
	`\n\n[ACCEPT EDITS MODE] All file edits and shell commands are auto-approved without confirmation. Only commands matching the configured unsafe patterns require confirmation. Proceed efficiently.`;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function planExtension(pi: ExtensionAPI): void {
	const config = resolveConfig(process.cwd());

	let currentMode: Mode = "default";
	let todoItems: TodoItem[] = [];
	let executionMode = false;
	let doneWhenText: string | undefined;
	// Ephemeral: set when the verification prompt is in flight, never restored.
	let verificationPending = false;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// ── State persistence ──────────────────────────────────────

	function persistMode(mode: Mode): void {
		pi.appendEntry("pledit-mode", { mode, timestamp: Date.now() });
	}

	function persistTracking(): void {
		pi.appendEntry("plan-mode", {
			enabled: false,
			todos: todoItems,
			executing: executionMode,
			doneWhenText,
		});
	}

	function readSavedMode(ctx: ExtensionContext): Mode {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; customType?: string; data?: { mode?: Mode } };
			if (e.type === "custom" && e.customType === "pledit-mode") {
				const mode = e.data?.mode;
				if (mode && MODE_CYCLE.includes(mode)) return mode;
			}
		}
		return "default";
	}

	// ── Status + widget ────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const parts: string[] = [];
		const label = statusLabel(currentMode);
		if (label) parts.push(label);
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			parts.push(ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		}
		ctx.ui.setStatus("pi-plan", parts.length > 0 ? parts.join(" ") : undefined);

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) =>
				item.completed
					? ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					: `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`,
			);
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function setMode(mode: Mode, ctx: ExtensionContext): void {
		currentMode = mode;
		persistMode(mode);
		updateStatus(ctx);
	}

	function clearTracking(ctx: ExtensionContext): void {
		executionMode = false;
		todoItems = [];
		doneWhenText = undefined;
		verificationPending = false;
		updateStatus(ctx);
		persistTracking();
	}

	// Begin tracking execution in the current chat. The marker entry bounds the
	// [DONE:n] rescan on resume, so a second plan in one session cannot inherit
	// the first plan's completions.
	function beginExecution(ctx: ExtensionContext): void {
		if (todoItems.length === 0) return;
		executionMode = true;
		pi.appendEntry("plan-mode-execute", { timestamp: Date.now() });
		persistTracking();
		updateStatus(ctx);
	}

	// ── Mode cycling ───────────────────────────────────────────

	pi.registerShortcut(config.shortcut, {
		description: "Cycle permission modes (default → accept edits → plan)",
		handler: async (ctx) => {
			const next = MODE_CYCLE[(MODE_CYCLE.indexOf(currentMode) + 1) % MODE_CYCLE.length]!;
			setMode(next, ctx);
			if (ctx.hasUI) ctx.ui.notify(notifyLabel(next, config), "info");
		},
	});

	// ── Prompt injection ───────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		const result: { systemPrompt?: string; message?: Parameters<typeof pi.sendMessage>[0] } = {};

		if (currentMode === "plan") {
			result.systemPrompt = event.systemPrompt + PLAN_MODE_PROMPT;
		} else if (currentMode === "acceptEdits") {
			result.systemPrompt = event.systemPrompt + ACCEPT_EDITS_PROMPT;
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			let content =
				`[EXECUTING PLAN]\n\nRemaining steps:\n` +
				remaining.map((t) => `${t.step}. ${t.text}`).join("\n") +
				`\n\nExecute each step in order.\nAfter completing a step, include a [DONE:n] tag in your response.`;
			if (doneWhenText) {
				content += `\n\nYour success criteria (to be verified after all steps are complete):\n${doneWhenText}`;
			}
			result.message = {
				customType: "plan-execution-context",
				content,
				display: false,
			};
		}

		return result;
	});

	// Legacy cleanup: an earlier version of this stack injected plan mode as a
	// hidden per-turn message rather than a system prompt. Those entries persist
	// in sessions recorded before this package, where they would keep telling the
	// model that write and edit are disabled long after plan mode was left.
	pi.on("context", async (event) => ({
		messages: event.messages.filter(
			(m) => (m as { customType?: string }).customType !== "plan-mode-context",
		),
	}));

	// ── Tool permission gating ─────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		// PLAN MODE — block writes/edits; gate bash to read-only
		if (currentMode === "plan") {
			if (event.toolName === "write" || event.toolName === "edit") {
				return {
					block: true,
					reason: `[PLAN MODE] ${event.toolName} is disabled. Describe this change in your plan text instead.`,
				};
			}
			if (event.toolName === "bash") {
				const cmd = (event.input as { command: string }).command;
				if (!isReadonlyBash(cmd, config)) {
					return { block: true, reason: `[PLAN MODE] Only read-only bash commands are allowed.` };
				}
			}
			return {}; // allow read, glob, grep, ls, and read-only bash
		}

		// DEFAULT MODE — prompt before every stateful tool; allow read-only bash silently
		if (currentMode === "default") {
			if (event.toolName === "write" || event.toolName === "edit") {
				if (!ctx.hasUI) return {};
				const input = event.input as { file_path?: string; path?: string };
				const filePath = input.file_path || input.path || "unknown";
				const ok = await ctx.ui.confirm("Confirm change", `Allow ${event.toolName} on ${filePath}?`);
				if (!ok) return { block: true, reason: "Denied by user" };
			}
			if (event.toolName === "bash") {
				const cmd = (event.input as { command: string }).command;
				if (isReadonlyBash(cmd, config)) return {}; // allow silently
				if (!ctx.hasUI) return {};
				const ok = await ctx.ui.confirm("Confirm command", `Allow: ${cmd}?`);
				if (!ok) return { block: true, reason: "Denied by user" };
			}
			return {};
		}

		// ACCEPT EDITS MODE — auto-approve everything except unsafe patterns
		if (currentMode === "acceptEdits" && event.toolName === "bash") {
			const cmd = (event.input as { command: string }).command;
			if (isUnsafe(cmd, config.unsafePatterns)) {
				if (!ctx.hasUI) return {};
				const ok = await ctx.ui.confirm("Confirm command", `Allow: ${cmd}?`);
				if (!ok) return { block: true, reason: "Denied by user" };
			}
		}

		return {};
	});

	// ── Progress tracking ──────────────────────────────────────

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		if (markCompletedSteps(getTextContent(event.message), todoItems) > 0) {
			updateStatus(ctx);
			persistTracking();
		}
	});

	// ── Plan capture, execution completion, verification ───────

	pi.on("agent_end", async (event, ctx) => {
		// The model has answered the verification prompt — close the plan out.
		if (verificationPending) {
			pi.sendMessage(
				{
					customType: "plan-complete",
					content: `**Plan Verified!** ✓\n\nAll steps completed and success criteria reviewed.`,
					display: true,
				},
				{ triggerTurn: false },
			);
			clearTracking(ctx);
			return;
		}

		// Mid-execution: check whether every step is done.
		if (executionMode && todoItems.length > 0) {
			if (!todoItems.every((t) => t.completed)) return;

			if (doneWhenText) {
				verificationPending = true;
				persistTracking();
				pi.sendUserMessage(
					`All plan steps are complete. Before considering this task done, verify against your success criteria:\n\n${doneWhenText}\n\n` +
						`For each criterion:\n` +
						`- ✓ Met — confirm with evidence from the work done\n` +
						`- ⚠ Partially met — explain what's missing\n` +
						`- ✗ Not met — describe what still needs to be done\n\n` +
						`If any criterion is not fully met, propose concrete next steps.`,
				);
			} else {
				pi.sendMessage(
					{
						customType: "plan-complete",
						content: `**Plan Complete!** ✓\n\n${todoItems.map((t) => `~~${t.text}~~`).join("\n")}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				clearTracking(ctx);
			}
			return;
		}

		// Otherwise: a plan-mode turn just finished — capture the plan.
		if (currentMode !== "plan" || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		const planText = getTextContent(lastAssistant).trim();
		if (!planText) return;

		const filepath = savePlan(ctx.cwd, planText, ctx.sessionManager.getSessionFile() ?? undefined);
		const rel = path.relative(ctx.cwd, filepath);
		ctx.ui.notify(`Plan saved to ${rel}`, "success");

		// Derive tracking state from the plan so any execution path can use it.
		todoItems = extractTodoItems(planText);
		doneWhenText = extractDoneWhenText(planText);

		if (todoItems.length > 0) {
			let summary =
				`**Plan Steps (${todoItems.length}):**\n\n` +
				todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
			if (doneWhenText) summary += `\n\n**Done When:**\n${doneWhenText}`;
			pi.sendMessage(
				{ customType: "plan-todo-list", content: summary, display: true },
				{ triggerTurn: false },
			);
			if (!doneWhenText) {
				ctx.ui.notify(
					'Tip: Add a "## Done When" section to your plan for automatic success verification.',
					"info",
				);
			}
		}

		const choice = await ctx.ui.select("The plan is ready to execute. Would you like to proceed?", [
			"1. Auto-accept edits",
			"2. Manually approve edits",
			"3. Provide further feedback",
			"4. Approve plan - open in new chat",
		]);

		if (choice === "1. Auto-accept edits" || choice === "2. Manually approve edits") {
			const auto = choice.startsWith("1.");
			setMode(auto ? "acceptEdits" : "default", ctx);
			beginExecution(ctx);
			pi.sendUserMessage(
				`Implement the approved plan from ${filepath}. ` +
					(auto
						? "Execute all steps without stopping for confirmation."
						: "Ask for confirmation before each file edit or shell command.") +
					(todoItems.length > 0
						? ` Start with step 1: ${todoItems[0]!.text}. Tag each finished step with [DONE:n].`
						: ""),
				{ deliverAs: "followUp" },
			);
		} else if (choice === "4. Approve plan - open in new chat") {
			// Hand off through the /plan-approve command rather than calling its
			// body directly: the fresh chat is created with ctx.newSession, which
			// only exists on the command context — the agent_end ctx has no such
			// method. Prefilling the editor routes the user through the
			// interactive path where commands are dispatched.
			// This chat stays in plan mode — it remains the read-only planning chat.
			ctx.ui.setEditorText(`/plan-approve ${rel}`);
			ctx.ui.notify(`Plan saved. Press Enter to execute it in a new chat.`, "info");
		}
		// "3. Provide further feedback" or dismissed — stay in plan mode.
	});

	// ── Commands ───────────────────────────────────────────────

	pi.registerCommand("plan-approve", {
		description: "Execute an approved plan file in a new chat",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const relPath = args?.trim();
			if (!relPath) {
				ctx.ui.notify("Usage: /plan-approve <path-to-plan.md>", "error");
				return;
			}
			const filepath = resolvePlanFilepath(relPath, ctx.cwd, ctx.sessionManager.getCwd());
			if (!filepath) {
				ctx.ui.notify(`Could not find plan file: ${relPath}`, "error");
				return;
			}
			let content: string;
			try {
				content = fs.readFileSync(filepath, "utf-8");
			} catch {
				ctx.ui.notify(`Could not read plan file: ${filepath}`, "error");
				return;
			}

			const body = parseFrontmatter(content).trim();
			if (!body) {
				ctx.ui.notify("Plan file is empty", "error");
				return;
			}

			// Re-derive tracking state so the new chat can resume it.
			const todos = extractTodoItems(body);
			const doneWhen = extractDoneWhenText(body);
			const parentSession = ctx.sessionManager.getSessionFile();

			await ctx.newSession({
				parentSession: parentSession ?? undefined,
				setup: async (sm) => {
					sm.appendMessage({
						role: "user",
						content: [{ type: "text", text: body }],
						timestamp: Date.now(),
					});
					if (todos.length > 0) {
						sm.appendCustomEntry("plan-mode", {
							enabled: false,
							todos,
							executing: true,
							doneWhenText: doneWhen,
						});
						sm.appendCustomEntry("plan-mode-execute", { timestamp: Date.now() });
					}
					// Start the implementer chat in accept-edits mode, matching the
					// "1. Auto-accept edits" flow.
					sm.appendCustomEntry("pledit-mode", { mode: "acceptEdits", timestamp: Date.now() });
				},
				withSession: async (newCtx) => {
					await newCtx.sendUserMessage(
						todos.length > 0
							? `Execute this plan. Start with step 1: ${todos[0]!.text}`
							: "Execute this plan",
					);
				},
			});
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Produce a plan in plan mode first.", "info");
				return;
			}
			const list = todoItems
				.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`)
				.join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerCommand("plans", {
		description: "Browse saved plans",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await showPlansTui(ctx, (planPath) => {
				ctx.ui.setEditorText(`${path.relative(ctx.cwd, planPath)}\nExecute this plan`);
				ctx.ui.notify("Plan path inserted into editor", "success");
			});
		},
	});

	pi.registerCommand("execute-plan", {
		description: "Execute a saved plan in a new session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await showPlansTui(ctx, async (planPath) => {
				let content: string;
				try {
					content = fs.readFileSync(planPath, "utf-8");
				} catch {
					ctx.ui.notify(`Could not read plan file: ${planPath}`, "error");
					return;
				}

				const body = parseFrontmatter(content).trim();
				if (!body) {
					ctx.ui.notify("Plan file is empty", "error");
					return;
				}

				const todos = extractTodoItems(body);
				const doneWhen = extractDoneWhenText(body);

				await ctx.newSession({
					parentSession: ctx.sessionManager.getSessionFile() ?? undefined,
					setup: async (sm) => {
						sm.appendMessage({
							role: "user",
							content: [{ type: "text", text: body }],
							timestamp: Date.now(),
						});
						if (todos.length > 0) {
							sm.appendCustomEntry("plan-mode", {
								enabled: false,
								todos,
								executing: true,
								doneWhenText: doneWhen,
							});
							sm.appendCustomEntry("plan-mode-execute", { timestamp: Date.now() });
						}
						sm.appendCustomEntry("pledit-mode", { mode: "acceptEdits", timestamp: Date.now() });
					},
					withSession: async (newCtx) => {
						await newCtx.sendUserMessage(
							todos.length > 0
								? `Execute this plan. Start with step 1: ${todos[0]!.text}`
								: "Execute this plan",
						);
					},
				});
			});
		},
	});

	// ── Session start / resume ─────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentMode = readSavedMode(ctx);
		if (pi.getFlag("plan") === true) currentMode = "plan";

		const entries = ctx.sessionManager.getEntries();

		const trackingEntry = entries
			.filter((e) => {
				const entry = e as { type?: string; customType?: string };
				return entry.type === "custom" && entry.customType === "plan-mode";
			})
			.pop() as
			| { data?: { todos?: TodoItem[]; executing?: boolean; doneWhenText?: string } }
			| undefined;

		if (trackingEntry?.data) {
			todoItems = trackingEntry.data.todos ?? [];
			executionMode = trackingEntry.data.executing ?? false;
			doneWhenText = trackingEntry.data.doneWhenText ?? undefined;
		}

		// verificationPending is ephemeral — always reset on resume.
		verificationPending = false;

		// Rebuild completion state from the transcript, scanning only messages
		// after the marker that started the current execution.
		if (executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if ((entries[i] as { customType?: string }).customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const texts: string[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i] as { type?: string; message?: unknown };
				if (entry.type === "message" && isAssistantMessage(entry.message)) {
					texts.push(getTextContent(entry.message));
				}
			}
			const allText = texts.join("\n");
			markCompletedSteps(allText, todoItems);

			// Re-derive the success criteria if they were lost.
			if (!doneWhenText) doneWhenText = extractDoneWhenText(allText);
		}

		updateStatus(ctx);
	});
}
