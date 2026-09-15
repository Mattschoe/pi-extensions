// Mentions Extension (pi-mentions)
//
// Merges the former `git-at` and `github-issue-reference` extensions into a
// single mention system: typed references in a prompt that expand into real
// context before the model sees them.
//
// Two mention triggers:
//
//  - `@` — git.
//      `@uncommitted` expands to the current working tree state: a
//      `<git-uncommitted cwd="...">` block with a relevance framing line,
//      `git status` (untracked + staged/unstaged split) and `git diff HEAD`
//      (staged+unstaged union). Unborn HEAD (empty repo) falls back to
//      untracked files + `git diff --cached`; a clean tree injects a short
//      framed note instead.
//      `@<hash>` expands to a `<git-commit hash="..." cwd="...">` block with a
//      relevance framing line plus the full `git show -m <hash>` output
//      (merge-safe).
//      Autocomplete stacks on pi's built-in `@` file picker: `@un…` suggests
//      `uncommitted` *above* the file matches, `@a…` suggests commits whose
//      hash starts with that prefix *below* them (files are referenced more
//      often, so they keep the top of the list and prune away as the prefix
//      grows), bare `@` lists `uncommitted` first. The `@"…"` quoted form still
//      tags a literal file.
//      Commit matching is hash-prefix only, from the first character. Fuzzy
//      search over commit *subjects* is deliberately gone: it could only ever
//      fire for hex-shaped words (`@dead`, `@cafe`, `@face`), which is never
//      what anyone means.
//
//  - `#` — GitHub issues. `#` autocompletes open issues in responsive aligned
//      columns for assignees, titles, colorized labels, and right-anchored
//      Project membership, inserts `[#N - Title]`, and injects the full issue
//      body *and its comment thread* as a separate collapsed message. `alt+g`
//      opens an issue in the browser —
//      the row highlighted in the `#` popup, else one referenced in the prompt,
//      else a picker over the loaded issues — and a dim hint under the editor
//      advertises the key whenever it would do something.
//      Requires `gh` on PATH, an authenticated `gh`, and a GitHub
//      remote; when any of those is missing the `#` provider is simply not
//      registered and `#` falls through to pi's default handling. The `@` half
//      keeps working regardless — it has no GitHub dependency.
//
// ---------------------------------------------------------------------------
// Why issue comments are included by default
// ---------------------------------------------------------------------------
//
// The load-bearing sentence in an issue is frequently a comment rather than the
// body: the body reports a symptom and a maintainer names the root cause, or the
// body is a template stub and a comment carries the acceptance criteria or the
// descope. Dropping the thread fails *silently* — the model implements a stale
// spec confidently. Including it costs tokens, which is loud and recoverable. So
// nothing is truncated or dropped by default except comments GitHub itself
// hides, and the caps in `mentions.json` (`.pi/mentions.json`, or the same file
// under `~/.pi/` / pi's agent dir) exist for people who hit a wall rather than as
// a default posture. See `MentionsConfig` for the keys.
//
// Each injected git block opens with a framing line that carries the user's
// intent: they referenced these changes to avoid restating them, so the model
// should use the injected data as given rather than asking the user to repeat
// themselves.
//
// Hard failures on the `@` side (unknown hash / not a git repository) block the
// message with an error notification instead of passing a dead reference to the
// model.
//
// ---------------------------------------------------------------------------
// Why there are two injection hooks
// ---------------------------------------------------------------------------
//
// The two halves inject at different points, and that difference is load
// bearing rather than historical accident:
//
//  - `@` runs on `pi.on("input")` and returns `{ action: "transform" }`. Pi
//    feeds the transformed text straight into the user message, so the token is
//    replaced in place — that is what makes `@uncommitted` read as part of the
//    prompt. `input` is also the only hook that can return `{ action:
//    "handled" }`, which is how an unknown hash blocks the message instead of
//    passing a dead reference to the model.
//
//  - `#` runs on `pi.on("before_agent_start")` and returns `{ message }`. Pi
//    appends that as a `role: "custom"` message *after* the user message, so
//    the prompt keeps the short, readable `[#N - Title]` reference and the
//    issue body renders as its own collapsed block (see the message renderer at
//    the bottom of this file). `before_agent_start` cannot abort a turn, and
//    moving `#` to `input` would splice whole issue bodies into the visible
//    prompt and make the renderer dead code.
//
// So the mention *providers* are unified — one token model, one autocomplete
// factory, one truncation path — while each provider declares which injection
// hook it uses. Merging the hooks themselves would regress one half or the
// other.

import type {
	ExtensionAPI,
	ExtensionContext,
	ExecResult,
	MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	CustomEditor,
	getAgentDir,
	rawKeyHint,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
	sliceByColumn,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BLOCK_CHARS = 100_000; // per-block truncation cap (git blocks)
// Deep enough that a single hex character still has a useful number of hits
// (~6 rather than ~2). Still one cached `git log` behind COMMIT_CACHE_TTL_MS.
const RECENT_COMMITS = 100;
const COMMIT_CACHE_TTL_MS = 5_000; // commits change as you work
const GIT_TIMEOUT_MS = 15_000;

const MAX_ISSUES = 100;
const MAX_ISSUE_SUGGESTIONS = 20;
const MAX_ASSIGNEE_TAG_WIDTH = 20;
const MAX_ISSUE_TITLE_WIDTH = 60;
const MAX_ISSUE_LABEL_WIDTH = 20;
const MAX_ISSUE_PROJECT_TAG_WIDTH = 24;
const ISSUE_COLUMN_GAP = 2;
const GH_AUTH_TIMEOUT_MS = 10_000;
const GH_LIST_TIMEOUT_MS = 10_000;
const GH_LIST_ATTEMPTS = 2;
const GH_VIEW_TIMEOUT_MS = 10_000;

const CONFIG_FILE_NAME = "mentions.json";

// Nothing is truncated and nothing is dropped except what GitHub itself hides.
// A referenced issue is referenced *because* its contents matter, so losing part
// of it silently is the worse failure — the caps exist for people who hit a wall,
// not as a default.
const DEFAULT_CONFIG: MentionsConfig = {
	includeComments: true,
	maxIssueChars: 0,
	maxComments: 0,
	dropComments: "middle",
	keepBots: true,
	keepMinimized: false,
};

// Only associations that mark someone as speaking *for* the repo are rendered.
// Tagging every drive-by `NONE` would add a column of noise to the common case.
const SIGNIFICANT_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// The real risk of injecting a thread is not tokens, it is anchoring: a proposal
// that the thread went on to reject, read as the plan. Chronological order plus
// this line is the mitigation.
const DISCUSSION_FRAMING =
	"The issue body above is the specification. These comments are discussion and may " +
	"contain proposals that were later rejected — read them in order and prefer the most " +
	"recent statement where they conflict.";

// `alt+g`, not a `ctrl+shift` chord. shift+ctrl+<letter> has no legacy terminal
// encoding at all — pi-tui can only match it through the Kitty keyboard
// protocol or xterm's modifyOtherKeys (keys.js: the `shift+ctrl` branch has no
// raw-byte fallback, unlike plain `ctrl`). In a terminal that negotiates
// neither, the keypress arrives as the bare control byte, so `shift+ctrl+g` was
// indistinguishable from `ctrl+g` and opened the external editor instead.
// `alt+<printable>` is ESC-prefixed in every terminal and needs no negotiation.
const OPEN_ISSUE_KEY = "alt+g";
const OPEN_ISSUE_HINT_KEY = "pi-mentions:open-issue";

// Match `@uncommitted` / `@<hex-hash>` at token boundaries.
// The lookbehind rejects `"@x`, `x@x` and mid-word refs; the lookahead
// rejects a following `@`. Because `uncommitted` / hex hashes must directly
// follow the `@`, the `@"..."` quoted form (literal file tag) never matches.
const UNCOMMITTED_RE = /(?<=^|[^\w@"])@uncommitted(?=$|[^\w@])/gi;
// 7+ hex on submit: 4-6 hex strings are common words (@cafe, @beef, @dead).
const COMMIT_RE = /(?<=^|[^\w@"])@([0-9a-f]{7,40})(?=$|[^\w@])/gi;
// The `[#N - Title]` form the `#` autocomplete inserts.
const ISSUE_REF_RE = /\[#(\d+)\s*-\s*(.*?)\]/g;

// Same delimiter set as pi's built-in file-path autocomplete.
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

// customType for the injected issue message. `github-issue-reference` is the
// legacy value; sessions recorded before the merge still carry it, so its
// renderer stays registered so old transcripts keep rendering.
const ISSUE_MESSAGE_TYPE = "pi-mentions:issue";
const LEGACY_ISSUE_MESSAGE_TYPE = "github-issue-reference";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GitToken =
	| { type: "uncommitted"; start: number; end: number }
	| { type: "commit"; hash: string; start: number; end: number };

type GitSection = { header: string; body: string };

type UncommittedResult = { clean: boolean; sections: GitSection[] };

type CommitInfo = {
	hash: string; // full hash (for git show)
	short: string; // abbreviated hash (for display)
	decorations: string; // e.g. "HEAD -> main, origin/main"
	subject: string;
};

type GitHubLabel = {
	name?: string;
	color?: string;
};

type GitHubProjectItem = {
	title?: string;
	status?: { name?: string } | null;
};

type GitHubIssue = {
	number: number;
	title: string;
	assignees: Array<{ login: string }>;
	labels?: GitHubLabel[];
	projectItems?: GitHubProjectItem[];
};

type ColorMode = "truecolor" | "256color";

type IssueDisplayLabel = {
	name: string;
	color?: string;
};

type IssueDisplayRow = {
	issue: GitHubIssue;
	assignee: string;
	labels: IssueDisplayLabel[];
	projects: string[];
};

type IssueListDisplay = {
	rows: IssueDisplayRow[];
	numberWidth: number;
	colorMode: ColorMode;
	naturalWidth: number;
	resolvedByWidth: Map<number, ResolvedIssueLayout>;
};

type IssueAutocompleteItem = AutocompleteItem & {
	piMentionsIssue: {
		row: IssueDisplayRow;
		list: IssueListDisplay;
	};
};

type IssueColumnWidths = {
	assignee: number;
	title: number;
	labels: number;
	projects: number;
};

type ResolvedIssueLayout = {
	tooNarrow: boolean;
	labelCount: number;
	projectCount: number;
	labelsActive: boolean;
	projectsActive: boolean;
	widths: IssueColumnWidths;
};

/** Which end of an over-long comment thread gets discarded. */
type DropComments = "oldest" | "middle" | "newest";

interface MentionsConfig {
	includeComments: boolean;
	/** Truncate the issue body past this many UTF-8 bytes; 0 = no truncation. */
	maxIssueChars: number;
	/** Keep at most this many comments; 0 = all of them. */
	maxComments: number;
	dropComments: DropComments;
	/** Keep comments authored by `*[bot]` accounts. */
	keepBots: boolean;
	/** Keep comments GitHub hides (spam / off-topic / abuse / outdated). */
	keepMinimized: boolean;
}

/**
 * One comment as `gh issue view --json comments` returns it. Every field is
 * optional because this is external JSON — notably `author` is null for deleted
 * accounts, and `minimizedReason` is null unless `isMinimized`.
 */
type IssueComment = {
	author?: { login?: string } | null;
	authorAssociation?: string;
	body?: string;
	createdAt?: string;
	isMinimized?: boolean;
	minimizedReason?: string | null;
};

type IssueBody = {
	title: string;
	body: string;
	comments?: IssueComment[];
};

/**
 * A cached issue plus whether it was fetched *with* comments. Without the flag a
 * body fetched while `includeComments` was false would keep being served after
 * the config is flipped on, for the rest of the session.
 */
type CachedIssue = { issue: IssueBody; withComments: boolean };

/**
 * Where a batch of mention items sits relative to the wrapped provider's
 * results. Placement varies *within* a spec — `@uncommitted` belongs above the
 * file matches, commits below them — so it travels with the result rather than
 * being a per-spec constant.
 */
type MentionPlacement = "above" | "below" | "replace";

type MentionResult = { items: AutocompleteItem[]; placement: MentionPlacement };

/**
 * The autocomplete half of a mention: how to recognise the token under the
 * cursor and what to offer for it. Both `@` and `#` are described this way, so
 * `createMentionProvider` is the only place that talks to pi's autocomplete
 * chain.
 */
type MentionSpec = {
	/** Characters that open this mention (advisory — pi always arms `@` and `#`). */
	triggerCharacters: string[];
	/**
	 * The mention token ending at the cursor, *including* its trigger character
	 * (`"@ab12"`, `"#42"`), or null when this is not our token — in which case
	 * the wrapped provider handles the position untouched.
	 */
	extractToken(textBeforeCursor: string): string | null;
	/**
	 * Items to offer for `token`, and where to put them. Empty items means
	 * "nothing to add, defer to the wrapped provider" whatever the placement.
	 */
	suggest(token: string, signal: AbortSignal): Promise<MentionResult>;
	/**
	 * Custom insertion behaviour. Receives the wrapped provider so it can defer
	 * for anything it does not recognise; omitted means "always defer".
	 */
	applyCompletion?: (
		current: AutocompleteProvider,
		...args: Parameters<AutocompleteProvider["applyCompletion"]>
	) => ReturnType<AutocompleteProvider["applyCompletion"]>;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
//
// Same shape and precedence as pi-branch-context: a missing file, malformed
// JSON, or a wrong-typed key is ignored silently and leaves the default in
// place. A config file is a convenience, so a typo in one key must never break
// mentions altogether.

function applyConfigFile(merged: MentionsConfig, filePath: string): void {
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

	if (typeof obj.includeComments === "boolean") merged.includeComments = obj.includeComments;
	if (typeof obj.keepBots === "boolean") merged.keepBots = obj.keepBots;
	if (typeof obj.keepMinimized === "boolean") merged.keepMinimized = obj.keepMinimized;
	if (
		obj.dropComments === "oldest" ||
		obj.dropComments === "middle" ||
		obj.dropComments === "newest"
	) {
		merged.dropComments = obj.dropComments;
	}
	if (
		typeof obj.maxIssueChars === "number" &&
		Number.isFinite(obj.maxIssueChars) &&
		obj.maxIssueChars >= 0
	) {
		merged.maxIssueChars = Math.floor(obj.maxIssueChars);
	}
	if (
		typeof obj.maxComments === "number" &&
		Number.isFinite(obj.maxComments) &&
		obj.maxComments >= 0
	) {
		merged.maxComments = Math.floor(obj.maxComments);
	}
}

/**
 * Read at each use site rather than cached at session_start: two small reads,
 * and config edits take effect without restarting pi.
 */
function loadConfig(cwd: string): MentionsConfig {
	const merged: MentionsConfig = { ...DEFAULT_CONFIG };
	// Global first (lowest precedence). Both `~/.pi/` and pi's agent dir work,
	// matching branch-context.
	applyConfigFile(merged, join(homedir(), ".pi", CONFIG_FILE_NAME));
	applyConfigFile(merged, join(getAgentDir(), CONFIG_FILE_NAME));
	// Project-local overrides both.
	applyConfigFile(merged, join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME));
	return merged;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Truncate a block body, appending a pointer to the command that produced it. */
function truncateBlock(content: string, hint: string): string {
	const result = truncateHead(content, { maxLines: 10_000, maxBytes: MAX_BLOCK_CHARS });
	if (!result.truncated) return content;
	const kept = result.content !== "" ? result.content : content.slice(0, MAX_BLOCK_CHARS);
	return `${kept}\n[truncated — full output via: ${hint}]`;
}

// ---------------------------------------------------------------------------
// Generic mention autocomplete provider
// ---------------------------------------------------------------------------

function createMentionProvider(
	current: AutocompleteProvider,
	spec: MentionSpec,
): AutocompleteProvider {
	return {
		triggerCharacters: spec.triggerCharacters,

		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = spec.extractToken(textBeforeCursor);
			if (token === null) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const { items, placement } = await spec.suggest(token, options.signal);
			if (options.signal.aborted) return null;

			// A satisfied `replace` never needs the wrapped provider, so it never
			// pays for the file lookup it would discard.
			if (placement === "replace" && items.length > 0) return { items, prefix: token };

			const wrapped = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (options.signal.aborted) return null;
			if (items.length === 0) return wrapped;

			const wrappedItems = wrapped?.items ?? [];
			return {
				items:
					placement === "below"
						? [...wrappedItems, ...items]
						: [...items, ...wrappedItems],
				prefix: token,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (spec.applyCompletion) {
				return spec.applyCompletion(current, lines, cursorLine, cursorCol, item, prefix);
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

// ===========================================================================
// `@` — git mentions
// ===========================================================================

async function runGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<ExecResult> {
	return pi.exec("git", ["--no-optional-locks", "-c", "color.ui=false", ...args], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	});
}

function collectGitTokens(text: string): GitToken[] {
	const tokens: GitToken[] = [];
	UNCOMMITTED_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = UNCOMMITTED_RE.exec(text)) !== null) {
		tokens.push({ type: "uncommitted", start: m.index, end: m.index + m[0].length });
	}
	COMMIT_RE.lastIndex = 0;
	while ((m = COMMIT_RE.exec(text)) !== null) {
		tokens.push({ type: "commit", hash: m[1], start: m.index, end: m.index + m[0].length });
	}
	return tokens;
}

async function fetchUncommitted(
	pi: ExtensionAPI,
	cwd: string,
): Promise<UncommittedResult | { error: string }> {
	const status = await runGit(pi, ["status"], cwd);
	if (status.code !== 0) {
		return { error: "not a git repository" };
	}
	const sections: GitSection[] = [];
	sections.push({ header: "git status", body: status.stdout.trimEnd() });

	const diff = await runGit(pi, ["diff", "HEAD"], cwd);
	if (diff.code === 0) {
		if (diff.stdout.trim() !== "") {
			sections.push({ header: "git diff HEAD", body: diff.stdout.trimEnd() });
		}
	} else {
		// Unborn HEAD (no commits yet): `git diff HEAD` fails. Fall back to
		// listing untracked files plus any staged (--cached) diff.
		const untracked = await runGit(pi, ["ls-files", "--others", "--exclude-standard"], cwd);
		if (untracked.code !== 0) {
			return { error: "git diff HEAD failed" };
		}
		if (untracked.stdout.trim() !== "") {
			sections.push({
				header: "untracked files (git ls-files --others --exclude-standard)",
				body: untracked.stdout.trimEnd(),
			});
		}
		const cached = await runGit(pi, ["diff", "--cached"], cwd);
		if (cached.code === 0 && cached.stdout.trim() !== "") {
			sections.push({ header: "git diff --cached", body: cached.stdout.trimEnd() });
		}
	}

	const porcelain = await runGit(pi, ["status", "--porcelain"], cwd);
	const clean = porcelain.code === 0 && porcelain.stdout.trim() === "";
	return { clean, sections };
}

async function fetchCommit(pi: ExtensionAPI, cwd: string, hash: string): Promise<string | null> {
	const result = await runGit(pi, ["show", "-m", hash], cwd);
	return result.code === 0 ? result.stdout : null;
}

const UNCOMMITTED_FRAMING =
	"The user referenced their latest uncommitted changes, which are relevant " +
	"to this request. Use them as given instead of asking the user to restate them.";
const UNCOMMITTED_FRAMING_CLEAN =
	"The user referenced their latest uncommitted changes: the working tree is " +
	"clean — no uncommitted changes.";
const COMMIT_FRAMING =
	"The user referenced this commit: full contents below, relevant to this request. " +
	"Use it as given instead of asking the user to restate it.";

function buildUncommittedBlock(result: UncommittedResult, cwd: string): string {
	const cwdAttr = `cwd="${escapeAttr(cwd)}"`;
	if (result.clean) {
		return `<git-uncommitted ${cwdAttr}>${UNCOMMITTED_FRAMING_CLEAN}</git-uncommitted>`;
	}
	const parts: string[] = [UNCOMMITTED_FRAMING];
	for (const section of result.sections) {
		parts.push(`[${section.header}]`, "", section.body);
	}
	const content = truncateBlock(parts.join("\n"), "git status && git diff HEAD");
	return `<git-uncommitted ${cwdAttr}>\n${content}\n</git-uncommitted>`;
}

function buildCommitBlock(hash: string, output: string, cwd: string): string {
	const content = truncateBlock(`${COMMIT_FRAMING}\n\n${output.trimEnd()}`, `git show -m ${hash}`);
	return `<git-commit hash="${hash}" cwd="${escapeAttr(cwd)}">\n${content}\n</git-commit>`;
}

// --- autocomplete ----------------------------------------------------------

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
	}
	return -1;
}

function hasUnclosedQuote(text: string): boolean {
	let inQuotes = false;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') inQuotes = !inQuotes;
	}
	return inQuotes;
}

// Mirrors pi's built-in extractAtPrefix: returns the `@...` token before the
// cursor, or null when the text is inside a `@"..."` / `"..."` quoted form
// (those are handled by the built-in as literal paths).
function extractGitAtToken(textBeforeCursor: string): string | null {
	if (hasUnclosedQuote(textBeforeCursor)) return null;
	const lastDelimiterIndex = findLastDelimiter(textBeforeCursor);
	const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
	if (textBeforeCursor[tokenStart] !== "@") return null;
	return textBeforeCursor.slice(tokenStart);
}

function classifyGitToken(token: string): "uncommitted" | "hex" | null {
	const raw = token.slice(1).toLowerCase();
	if (raw === "") return "uncommitted";
	if ("uncommitted".startsWith(raw)) return "uncommitted";
	// From the very first character: commits surface gradually as file matches
	// prune away, rather than appearing all at once at a fixed width.
	if (/^[0-9a-f]{1,40}$/.test(raw)) return "hex";
	return null;
}

function parseLogOutput(stdout: string): CommitInfo[] {
	const commits: CommitInfo[] = [];
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const [hash, short, decorations, ...subjectParts] = line.split("\t");
		if (!hash || !short) continue;
		commits.push({
			hash,
			short,
			decorations: decorations ?? "",
			subject: subjectParts.join("\t") ?? "",
		});
	}
	return commits;
}

let commitCache: { cwd: string; at: number; commits: CommitInfo[] } | undefined;

async function getRecentCommits(pi: ExtensionAPI, cwd: string): Promise<CommitInfo[]> {
	const now = Date.now();
	if (commitCache && commitCache.cwd === cwd && now - commitCache.at < COMMIT_CACHE_TTL_MS) {
		return commitCache.commits;
	}
	let commits: CommitInfo[] = [];
	const result = await runGit(
		pi,
		["log", `-${RECENT_COMMITS}`, "--decorate=short", "--format=%H%x09%h%x09%D%x09%s"],
		cwd,
	);
	if (result.code === 0) {
		commits = parseLogOutput(result.stdout);
	}
	// Empty repos (`git log` exit 128) cache as [] — no suggestions, not an error.
	commitCache = { cwd, at: now, commits };
	return commits;
}

// No `description`: SelectList renders a described item as two columns with the
// label hard-clamped to 32 chars, which truncated the subject *and* repeated it
// in full. Without one the row gets the whole terminal width, and SelectList
// does the truncating.
function formatCommitItem(commit: CommitInfo): AutocompleteItem {
	const decorations = commit.decorations ? ` (${commit.decorations})` : "";
	return {
		value: `@${commit.hash}`,
		label: `@${commit.short} ${commit.subject}${decorations}`,
	};
}

function createGitMentionSpec(pi: ExtensionAPI, cwd: string, gitAvailable: boolean): MentionSpec {
	return {
		triggerCharacters: ["@"],

		extractToken(textBeforeCursor) {
			const token = extractGitAtToken(textBeforeCursor);
			if (token === null) return null;
			// Not a git-shaped token (`@src/foo.ts`): let the file picker own it.
			return classifyGitToken(token) === null ? null : token;
		},

		async suggest(token) {
			if (!gitAvailable) return { items: [], placement: "above" };
			if (classifyGitToken(token) === "uncommitted") {
				// `description` is a genuine explanation here, not a duplicate of
				// the label, and the row renders on its own.
				return {
					items: [
						{
							value: "@uncommitted",
							label: "@uncommitted",
							description: "Latest uncommitted changes (git status + git diff HEAD)",
						},
					],
					// Above the file picker: the Phase 0 acceptance criterion.
					placement: "above",
				};
			}
			// `classifyGitToken` only routes pure hex here, so the token *is* a
			// hash prefix — match it as one. Fuzzy matching over a 40-hex-digit
			// haystack would return ~every commit for a one-character query.
			const query = token.slice(1).toLowerCase();
			const commits = await getRecentCommits(pi, cwd);
			const items = commits
				.filter((c) => c.hash.startsWith(query))
				.slice(0, 10)
				.map(formatCommitItem);
			// Below the file picker: files are referenced more often, and they
			// prune away over the same keystrokes that narrow the commit list.
			return { items, placement: "below" };
		},
	};
}

// ===========================================================================
// `#` — GitHub issue mentions
// ===========================================================================

/**
 * Pi exposes timeout/abort separately from the exit code. In pi 0.83 a process
 * terminated by a signal can have its null exit code normalized to 0, so code
 * alone is not a success check.
 */
const execSucceeded = (result: ExecResult): boolean => result.code === 0 && !result.killed;

function execFailureDetails(result: ExecResult, timeoutMs: number): string {
	if (result.killed) {
		const seconds = timeoutMs / 1_000;
		return `timed out after ${seconds} second${seconds === 1 ? "" : "s"}`;
	}
	return result.stderr.trim() || `exit code ${result.code}`;
}

function parseGitHubRepo(remoteUrl: string): string | undefined {
	const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
	if (sshMatch) return sshMatch[1];

	const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
	if (httpsMatch) return httpsMatch[1];

	return undefined;
}

async function resolveGitHubRepo(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await pi.exec("git", ["remote", "-v"], { cwd, timeout: 5_000 });
	if (!execSucceeded(result)) return undefined; // not a git repository, or timed out

	for (const line of result.stdout.split("\n")) {
		const columns = line.trim().split(/\s+/);
		const remoteUrl = columns[1];
		if (!remoteUrl) continue;
		const repo = parseGitHubRepo(remoteUrl);
		if (repo) return repo;
	}
	return undefined; // git repo, but no GitHub remote
}

/**
 * True when `gh` is installed *and* authenticated. A missing binary makes
 * pi.exec resolve with a non-zero code rather than throwing, so this one call
 * covers both conditions.
 */
async function isGhUsable(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await pi.exec("gh", ["auth", "status"], {
		cwd,
		timeout: GH_AUTH_TIMEOUT_MS,
	});
	return execSucceeded(result);
}

async function fetchIssueBody(
	pi: ExtensionAPI,
	repo: string,
	issueNumber: number,
	cwd: string,
	withComments: boolean,
): Promise<IssueBody | null> {
	// `comments` is requested only when it will be used, so the comment-free
	// configuration keeps paying for the cheaper query.
	const fields = withComments ? "title,body,comments" : "title,body";
	const result = await pi.exec(
		"gh",
		["issue", "view", String(issueNumber), "--repo", repo, "--json", fields],
		{ cwd, timeout: GH_VIEW_TIMEOUT_MS },
	);
	if (!execSucceeded(result)) return null;

	try {
		return JSON.parse(result.stdout) as IssueBody;
	} catch {
		return null;
	}
}

function issueAssigneeText(issue: GitHubIssue): string {
	const logins = (issue.assignees ?? [])
		.map((assignee) => assignee.login?.trim())
		.filter((login): login is string => Boolean(login));
	return logins.length > 0 ? logins.join(", ") : "not-assigned";
}

const COLOR_CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;
const COLOR_GRAY_VALUES = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

function closestColorIndex(value: number, candidates: readonly number[]): number {
	let closest = 0;
	let distance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < candidates.length; index += 1) {
		const nextDistance = Math.abs(value - candidates[index]!);
		if (nextDistance < distance) {
			closest = index;
			distance = nextDistance;
		}
	}
	return closest;
}

function colorDistance(
	left: readonly [number, number, number],
	right: readonly [number, number, number],
): number {
	const red = left[0] - right[0];
	const green = left[1] - right[1];
	const blue = left[2] - right[2];
	return red * red * 0.299 + green * green * 0.587 + blue * blue * 0.114;
}

/** Map an RGB label color to the nearest xterm-256 cube or grayscale entry. */
function rgbTo256(red: number, green: number, blue: number): number {
	const redIndex = closestColorIndex(red, COLOR_CUBE_VALUES);
	const greenIndex = closestColorIndex(green, COLOR_CUBE_VALUES);
	const blueIndex = closestColorIndex(blue, COLOR_CUBE_VALUES);
	const cube: [number, number, number] = [
		COLOR_CUBE_VALUES[redIndex]!,
		COLOR_CUBE_VALUES[greenIndex]!,
		COLOR_CUBE_VALUES[blueIndex]!,
	];
	const cubeColor = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;

	const gray = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
	const grayIndex = closestColorIndex(gray, COLOR_GRAY_VALUES);
	const grayValue = COLOR_GRAY_VALUES[grayIndex]!;
	const grayscale: [number, number, number] = [grayValue, grayValue, grayValue];

	// Preserve a visible hue unless the source is effectively neutral, matching
	// pi's own theme conversion rather than washing muted labels out to gray.
	const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
	if (
		spread < 10 &&
		colorDistance([red, green, blue], grayscale) < colorDistance([red, green, blue], cube)
	) {
		return 232 + grayIndex;
	}
	return cubeColor;
}

/** Apply one label's GitHub color after truncation, or leave it plain. */
function colorIssueLabel(label: IssueDisplayLabel, text: string, colorMode: ColorMode): string {
	const color = label.color?.trim();
	if (!color || !/^[0-9a-f]{6}$/i.test(color)) return text;

	const red = Number.parseInt(color.slice(0, 2), 16);
	const green = Number.parseInt(color.slice(2, 4), 16);
	const blue = Number.parseInt(color.slice(4, 6), 16);
	const ansi =
		colorMode === "truecolor"
			? `\x1b[38;2;${red};${green};${blue}m`
			: `\x1b[38;5;${rgbTo256(red, green, blue)}m`;
	return `${ansi}${text}\x1b[39m`;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
	return [
		...new Set(
			values
				.map((value) => value?.trim())
				.filter((value): value is string => Boolean(value)),
		),
	];
}

/** Truncate unstyled text by terminal cells without injecting an ANSI reset. */
function truncatePlain(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	if (maxWidth === 1) return "…";
	return `${sliceByColumn(text, 0, maxWidth - 1, true)}…`;
}

function padVisibleEnd(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padVisibleStart(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function formatBracketed(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (maxWidth === 1) return "…";
	if (maxWidth === 2) return "[]";
	return `[${truncatePlain(text, maxWidth - 2)}]`;
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

/**
 * Share a deficit by each element's shrinkable width. Longer elements lose
 * more cells, while every element above its minimum participates.
 */
function allocateWeightedWidths(
	preferred: readonly number[],
	minimum: readonly number[],
	available: number,
): number[] {
	const preferredTotal = sum(preferred);
	if (available >= preferredTotal) return [...preferred];
	const minimumTotal = sum(minimum);
	if (available <= minimumTotal) return [...minimum];

	const capacities = preferred.map((width, index) => width - (minimum[index] ?? 0));
	const capacityTotal = sum(capacities);
	const deficit = preferredTotal - available;
	if (capacityTotal <= 0 || deficit <= 0) return [...preferred];

	const exactReductions = capacities.map((capacity) => (deficit * capacity) / capacityTotal);
	const reductions = exactReductions.map((reduction) => Math.floor(reduction));
	let remainder = deficit - sum(reductions);
	const ranked = exactReductions
		.map((reduction, index) => ({
			index,
			fraction: reduction - Math.floor(reduction),
			capacity: capacities[index] ?? 0,
		}))
		.sort(
			(left, right) =>
				right.fraction - left.fraction ||
				right.capacity - left.capacity ||
				left.index - right.index,
		);
	for (const entry of ranked) {
		if (remainder <= 0) break;
		if ((reductions[entry.index] ?? 0) >= entry.capacity) continue;
		reductions[entry.index] = (reductions[entry.index] ?? 0) + 1;
		remainder -= 1;
	}

	return preferred.map((width, index) => width - (reductions[index] ?? 0));
}

function preferredLabelGroupWidth(labels: readonly IssueDisplayLabel[]): number {
	if (labels.length === 0) return 0;
	return (
		2 +
		labels.reduce(
			(total, label) => total + Math.min(visibleWidth(label.name), MAX_ISSUE_LABEL_WIDTH),
			0,
		) +
		ISSUE_COLUMN_GAP * (labels.length - 1)
	);
}

function minimumLabelGroupWidth(count: number): number {
	return count === 0 ? 0 : 2 + count + ISSUE_COLUMN_GAP * (count - 1);
}

function preferredProjectGroupWidth(projects: readonly string[]): number {
	return projects.reduce(
		(total, project, index) =>
			total +
			(index > 0 ? 1 : 0) +
			Math.min(visibleWidth(project) + 2, MAX_ISSUE_PROJECT_TAG_WIDTH),
		0,
	);
}

function minimumProjectGroupWidth(count: number): number {
	return count === 0 ? 0 : count * 3 + (count - 1);
}

type IssueColumnMetrics = {
	labelsActive: boolean;
	projectsActive: boolean;
	fixedWidth: number;
	preferred: IssueColumnWidths;
	minimum: IssueColumnWidths;
};

function issueColumnMetrics(
	list: IssueListDisplay,
	labelCount: number,
	projectCount: number,
): IssueColumnMetrics {
	const labelsActive = labelCount > 0 && list.rows.some((row) => row.labels.length > 0);
	const projectsActive = projectCount > 0 && list.rows.some((row) => row.projects.length > 0);
	const columnCount = 3 + Number(labelsActive) + Number(projectsActive);
	const maxAcrossRows = (measure: (row: IssueDisplayRow) => number): number =>
		list.rows.reduce((widest, row) => Math.max(widest, measure(row)), 0);

	return {
		labelsActive,
		projectsActive,
		fixedWidth: list.numberWidth + ISSUE_COLUMN_GAP * (columnCount - 1),
		preferred: {
			assignee: maxAcrossRows((row) =>
				Math.min(visibleWidth(`[${row.assignee}]`), MAX_ASSIGNEE_TAG_WIDTH),
			),
			title: Math.max(
				1,
				maxAcrossRows((row) => Math.min(visibleWidth(row.issue.title), MAX_ISSUE_TITLE_WIDTH)),
			),
			labels: labelsActive
				? maxAcrossRows((row) => preferredLabelGroupWidth(row.labels.slice(0, labelCount)))
				: 0,
			projects: projectsActive
				? maxAcrossRows((row) => preferredProjectGroupWidth(row.projects.slice(0, projectCount)))
				: 0,
		},
		minimum: {
			assignee: 3,
			title: 1,
			labels: labelsActive
				? maxAcrossRows((row) => minimumLabelGroupWidth(row.labels.slice(0, labelCount).length))
				: 0,
			projects: projectsActive
				? maxAcrossRows((row) => minimumProjectGroupWidth(row.projects.slice(0, projectCount).length))
				: 0,
		},
	};
}

function resolveIssueLayout(list: IssueListDisplay, maxWidth: number): ResolvedIssueLayout {
	const cached = list.resolvedByWidth.get(maxWidth);
	if (cached) return cached;

	let labelCount = list.rows.reduce((largest, row) => Math.max(largest, row.labels.length), 0);
	let projectCount = list.rows.reduce((largest, row) => Math.max(largest, row.projects.length), 0);
	let metrics = issueColumnMetrics(list, labelCount, projectCount);
	const minimumTotal = (): number => metrics.fixedWidth + sum(Object.values(metrics.minimum));

	// Preserve all metadata until every retained element would already be at its
	// one-cell ellipsis form. At that point projects disappear before labels.
	while (projectCount > 0 && minimumTotal() > maxWidth) {
		projectCount -= 1;
		metrics = issueColumnMetrics(list, labelCount, projectCount);
	}
	while (labelCount > 0 && minimumTotal() > maxWidth) {
		labelCount -= 1;
		metrics = issueColumnMetrics(list, labelCount, projectCount);
	}

	if (minimumTotal() > maxWidth) {
		const tooNarrow: ResolvedIssueLayout = {
			tooNarrow: true,
			labelCount: 0,
			projectCount: 0,
			labelsActive: false,
			projectsActive: false,
			widths: { assignee: 0, title: 0, labels: 0, projects: 0 },
		};
		list.resolvedByWidth.set(maxWidth, tooNarrow);
		return tooNarrow;
	}

	const keys: Array<keyof IssueColumnWidths> = ["assignee", "title"];
	if (metrics.labelsActive) keys.push("labels");
	if (metrics.projectsActive) keys.push("projects");
	const allocated = allocateWeightedWidths(
		keys.map((key) => metrics.preferred[key]),
		keys.map((key) => metrics.minimum[key]),
		maxWidth - metrics.fixedWidth,
	);
	const widths: IssueColumnWidths = { assignee: 0, title: 0, labels: 0, projects: 0 };
	keys.forEach((key, index) => {
		widths[key] = allocated[index] ?? 0;
	});

	const resolved: ResolvedIssueLayout = {
		tooNarrow: false,
		labelCount,
		projectCount,
		labelsActive: metrics.labelsActive,
		projectsActive: metrics.projectsActive,
		widths,
	};
	list.resolvedByWidth.set(maxWidth, resolved);
	return resolved;
}

function formatLabelGroup(
	labels: readonly IssueDisplayLabel[],
	maxWidth: number,
	colorMode: ColorMode,
): string {
	if (labels.length === 0 || maxWidth <= 0) return "";
	const overhead = 2 + ISSUE_COLUMN_GAP * (labels.length - 1);
	const preferred = labels.map((label) =>
		Math.min(visibleWidth(label.name), MAX_ISSUE_LABEL_WIDTH),
	);
	const widths = allocateWeightedWidths(preferred, labels.map(() => 1), maxWidth - overhead);
	const rendered = labels.map((label, index) =>
		colorIssueLabel(label, truncatePlain(label.name, widths[index] ?? 1), colorMode),
	);
	return `(${rendered.join(", ")})`;
}

function formatProjectGroup(projects: readonly string[], maxWidth: number): string {
	if (projects.length === 0 || maxWidth <= 0) return "";
	const overhead = projects.length * 2 + (projects.length - 1);
	const preferred = projects.map((project) =>
		Math.min(visibleWidth(project), MAX_ISSUE_PROJECT_TAG_WIDTH - 2),
	);
	const widths = allocateWeightedWidths(preferred, projects.map(() => 1), maxWidth - overhead);
	return projects
		.map((project, index) => `[${truncatePlain(project, widths[index] ?? 1)}]`)
		.join(" ");
}

function formatIssueRow(
	row: IssueDisplayRow,
	list: IssueListDisplay,
	maxWidth: number,
): string {
	const layout = resolveIssueLayout(list, maxWidth);
	if (layout.tooNarrow) {
		const core = `#${row.issue.number}  [${row.assignee}]  ${row.issue.title}`;
		return truncateToWidth(core, maxWidth, "…");
	}

	const number = padVisibleEnd(`#${row.issue.number}`, list.numberWidth);
	const assignee = padVisibleEnd(
		formatBracketed(row.assignee, layout.widths.assignee),
		layout.widths.assignee,
	);
	const title = padVisibleEnd(
		truncatePlain(row.issue.title, layout.widths.title),
		layout.widths.title,
	);
	let result = `${number}${" ".repeat(ISSUE_COLUMN_GAP)}${assignee}`;
	result += `${" ".repeat(ISSUE_COLUMN_GAP)}${title}`;

	if (layout.labelsActive) {
		const labels = formatLabelGroup(
			row.labels.slice(0, layout.labelCount),
			layout.widths.labels,
			list.colorMode,
		);
		result += `${" ".repeat(ISSUE_COLUMN_GAP)}${padVisibleEnd(labels, layout.widths.labels)}`;
	}

	if (layout.projectsActive) {
		const projects = formatProjectGroup(
			row.projects.slice(0, layout.projectCount),
			layout.widths.projects,
		);
		const projectStart = maxWidth - layout.widths.projects;
		result += " ".repeat(Math.max(ISSUE_COLUMN_GAP, projectStart - visibleWidth(result)));
		result += padVisibleStart(projects, layout.widths.projects);
	}

	return result;
}

function isIssueAutocompleteItem(item: AutocompleteItem | null | undefined): item is IssueAutocompleteItem {
	return Boolean(item && "piMentionsIssue" in item);
}

/**
 * Every item carries the same per-suggestion-list layout model. Its static label
 * is the capped natural-width fallback; MentionsEditor reformats it with the
 * SelectList's actual width on every render.
 */
function formatIssueItems(issues: GitHubIssue[], colorMode: ColorMode): AutocompleteItem[] {
	if (issues.length === 0) return [];
	const rows: IssueDisplayRow[] = issues.map((issue) => ({
		issue,
		assignee: issueAssigneeText(issue),
		labels: (issue.labels ?? [])
			.map((label) => ({ name: label.name?.trim() ?? "", color: label.color }))
			.filter((label) => label.name !== ""),
		projects: uniqueNonEmpty((issue.projectItems ?? []).map((item) => item.title)),
	}));
	const list: IssueListDisplay = {
		rows,
		numberWidth: rows.reduce(
			(widest, row) => Math.max(widest, visibleWidth(`#${row.issue.number}`)),
			0,
		),
		colorMode,
		naturalWidth: 0,
		resolvedByWidth: new Map(),
	};
	const naturalMetrics = issueColumnMetrics(
		list,
		rows.reduce((largest, row) => Math.max(largest, row.labels.length), 0),
		rows.reduce((largest, row) => Math.max(largest, row.projects.length), 0),
	);
	list.naturalWidth = naturalMetrics.fixedWidth + sum(Object.values(naturalMetrics.preferred));

	return rows.map((row) => {
		const item: IssueAutocompleteItem = {
			value: `#${row.issue.number}`,
			label: "",
			piMentionsIssue: { row, list },
		};
		item.label = formatIssueRow(row, list, list.naturalWidth);
		return item;
	});
}

function filterIssues(issues: GitHubIssue[], query: string): GitHubIssue[] {
	if (!query.trim()) {
		return issues.slice(0, MAX_ISSUE_SUGGESTIONS);
	}

	if (/^\d+$/.test(query)) {
		const numericMatches = issues
			.filter((issue) => String(issue.number).startsWith(query))
			.slice(0, MAX_ISSUE_SUGGESTIONS);
		if (numericMatches.length > 0) return numericMatches;
	}

	return fuzzyFilter(issues, query, (issue) => `${issue.number} ${issue.title}`).slice(
		0,
		MAX_ISSUE_SUGGESTIONS,
	);
}

// Returns the `#...` token ending at the cursor, including the `#`.
function extractIssueToken(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(/(?:^|[ \t])(#[^\s#]*)$/);
	return match?.[1] ?? null;
}

function createIssueMentionSpec(
	getIssues: () => Promise<GitHubIssue[] | undefined>,
	lookupIssue: (issueNumber: number) => GitHubIssue | undefined,
	onIssueSelected: (issueNumber: number) => void,
	colorMode: ColorMode,
): MentionSpec {
	return {
		triggerCharacters: ["#"],
		extractToken: extractIssueToken,

		async suggest(token) {
			const issues = await getIssues();
			// Issue suggestions replace rather than stack: `#` has no builtin meaning.
			if (!issues || issues.length === 0) return { items: [], placement: "replace" };
			return {
				items: formatIssueItems(filterIssues(issues, token.slice(1)), colorMode),
				placement: "replace",
			};
		},

		// Selecting an issue inserts `[#N - Title]` — the bracketed form the
		// prompt scan looks for — instead of the bare `#N` value.
		applyCompletion(current, lines, cursorLine, cursorCol, item, prefix) {
			const issueNumber = Number.parseInt(item.value.replace(/^#/, ""), 10);
			if (Number.isNaN(issueNumber)) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}

			// Keep completion independent of the responsive/ANSI display. Structured
			// issue items carry the full title; loadedIssues and textual parsing are
			// fallbacks for foreign, hand-built, or stale items.
			const issueTitle =
				(isIssueAutocompleteItem(item) ? item.piMentionsIssue.row.issue.title : undefined) ??
				lookupIssue(issueNumber)?.title ??
				item.label.replace(/^#\d+\s+(\[[^\]]*\]\s+)?/, "").trim();
			const reference = `[#${issueNumber} - ${issueTitle}]`;

			const line = lines[cursorLine] ?? "";
			const prefixStart = cursorCol - prefix.length;
			const newLines = [...lines];
			newLines[cursorLine] = line.slice(0, prefixStart) + reference + line.slice(cursorCol);

			onIssueSelected(issueNumber);

			return { lines: newLines, cursorLine, cursorCol: prefixStart + reference.length };
		},
	};
}

/**
 * Pi's editor, extended with a read of the suggestion popup's highlighted row.
 *
 * Needed because `alt+g` should act on the issue the user is looking at, and
 * nothing in the public surface reports it: `AutocompleteItem` carries no
 * action hook, and the editor keeps the selected index private. `private` in
 * `Editor` is a compile-time annotation only, so `autocompleteList` is an
 * ordinary property at runtime.
 *
 * Installing this is a supported path rather than a hack —
 * `setCustomEditorComponent` duck-types for `actionHandlers` and copies pi's
 * own escape / ctrl+d / paste-image / extension-shortcut handlers and every
 * app action onto whatever the factory returns, specifically so extensions can
 * subclass `CustomEditor`. Extension shortcuts are dispatched *before* the
 * popup's key handling (`CustomEditor.handleInput` checks
 * `onExtensionShortcut` first), so `alt+g` reaches us with the popup open.
 *
 * Caveat: pi passes the factory only `(tui, theme, keybindings)`, and copies
 * `paddingX` across afterwards but not `autocompleteMaxVisible` — a custom
 * editor always uses the built-in default of 5 rows. That matches the current
 * setting; a future `autocompleteMaxVisible` in settings.json would not apply
 * while this editor is installed.
 */
type RuntimeAutocompleteList = {
	getSelectedItem?(): AutocompleteItem | null | undefined;
	layout?: {
		truncatePrimary?: (context: {
			text: string;
			maxWidth: number;
			item: AutocompleteItem;
		}) => string;
	};
};

class MentionsEditor extends CustomEditor {
	/** Fired after each keystroke so the extension can refresh its hint. */
	onSelectionMaybeChanged?: () => void;

	private runtimeAutocompleteList(): RuntimeAutocompleteList | undefined {
		return (this as unknown as { autocompleteList?: RuntimeAutocompleteList }).autocompleteList;
	}

	/** The popup's highlighted row, or undefined when no popup is open. */
	getHighlightedItem(): AutocompleteItem | undefined {
		if (!this.isShowingAutocomplete()) return undefined;
		return this.runtimeAutocompleteList()?.getSelectedItem?.() ?? undefined;
	}

	override render(width: number): string[] {
		// SelectList knows the true width only during render. Install its supported
		// truncation callback through the runtime-visible list object so issue rows
		// can share that width across columns. If Pi changes this private bridge,
		// the preformatted capped label remains a safe fallback.
		try {
			const list = this.runtimeAutocompleteList();
			const selected = list?.getSelectedItem?.();
			if (list && isIssueAutocompleteItem(selected)) {
				list.layout ??= {};
				list.layout.truncatePrimary = ({ text, maxWidth, item }) => {
					if (!isIssueAutocompleteItem(item)) return truncateToWidth(text, maxWidth, "");
					return formatIssueRow(
						item.piMentionsIssue.row,
						item.piMentionsIssue.list,
						maxWidth,
					);
				};
			}
		} catch {
			// Private runtime integration is best-effort; ordinary SelectList
			// truncation still guarantees a bounded row.
		}
		return super.render(width);
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		// Synchronous pass catches arrow keys moving the selection in a popup
		// that is already open.
		this.onSelectionMaybeChanged?.();
		// Suggestions resolve asynchronously, so a popup that *this* keystroke
		// opens does not exist yet above. The issue list is cached after the
		// first load, making that chain pure microtasks — settled well before a
		// zero-delay timer.
		setTimeout(() => {
			try {
				this.onSelectionMaybeChanged?.();
			} catch {
				// A hint refresh is never worth a crash, and a throw out of a
				// timer is fatal to pi. The realistic cause is a session
				// replaced between the keystroke and this tick.
			}
		}, 0);
	}
}

type IssueRef = { number: number; title: string };

/** Deduped by number, keeping the first title seen for it. */
function collectIssueRefs(text: string): IssueRef[] {
	const refs: IssueRef[] = [];
	ISSUE_REF_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ISSUE_REF_RE.exec(text)) !== null) {
		const num = Number.parseInt(match[1], 10);
		if (Number.isNaN(num) || refs.some((ref) => ref.number === num)) continue;
		refs.push({ number: num, title: (match[2] ?? "").trim() });
	}
	return refs;
}

const isBotLogin = (login: string): boolean => /\[bot\]$/i.test(login);

/**
 * Policy filtering, before any cap applies. Minimized comments are dropped by
 * default because github.com itself collapses them: injecting spam and abuse
 * would show the model something a human reading the issue would not see.
 * Bots are kept by default — a CI failure or a stack trace posted by a bot is
 * often the most useful thing in the thread.
 */
function filterComments(comments: IssueComment[], config: MentionsConfig): IssueComment[] {
	return comments.filter((comment) => {
		if (!config.keepMinimized && comment.isMinimized === true) return false;
		if (!config.keepBots && isBotLogin(comment.author?.login ?? "")) return false;
		// Reaction-only rows carry no text to inject.
		return (comment.body ?? "").trim() !== "";
	});
}

type CommentSelection = {
	kept: IssueComment[];
	/** How many were cut. 0 means `kept` is the whole list. */
	omitted: number;
	/** Index within `kept` where the cut happened, so the gap renders in place. */
	gapAt: number;
};

/**
 * Apply `maxComments`. Which end goes is the caller's choice because the useful
 * end varies: the earliest comments carry context, the latest carry the current
 * state, and `middle` (the default) keeps both because that is where the
 * "+1 / any updates?" filler lives.
 */
function selectComments(
	comments: IssueComment[],
	maxComments: number,
	dropComments: DropComments,
): CommentSelection {
	if (maxComments <= 0 || comments.length <= maxComments) {
		return { kept: comments, omitted: 0, gapAt: comments.length };
	}
	const omitted = comments.length - maxComments;
	if (dropComments === "oldest") {
		return { kept: comments.slice(-maxComments), omitted, gapAt: 0 };
	}
	if (dropComments === "newest") {
		return { kept: comments.slice(0, maxComments), omitted, gapAt: maxComments };
	}
	const head = Math.ceil(maxComments / 2);
	const tail = maxComments - head;
	const kept = [...comments.slice(0, head), ...(tail > 0 ? comments.slice(-tail) : [])];
	return { kept, omitted, gapAt: head };
}

function formatComment(comment: IssueComment): string[] {
	const login = comment.author?.login ?? "ghost"; // deleted account
	const association = (comment.authorAssociation ?? "").toUpperCase();
	const tag = SIGNIFICANT_ASSOCIATIONS.has(association) ? ` (${association})` : "";
	const date = (comment.createdAt ?? "").slice(0, 10);
	return [`**@${login}**${tag}${date ? ` — ${date}` : ""}`, "", (comment.body ?? "").trim(), ""];
}

function buildIssueBlock(
	repo: string,
	number: number,
	issue: IssueBody,
	config: MentionsConfig,
): string[] {
	const url = `https://github.com/${repo}/issues/${number}`;
	const parts = [`## Referenced issue #${number} - ${issue.title}`, ""];

	// Truncation is opt-in: an issue is referenced *because* its contents matter,
	// so cutting it by default defeats the reference.
	if (config.maxIssueChars > 0) {
		const truncation = truncateHead(issue.body ?? "", {
			maxLines: Number.MAX_SAFE_INTEGER,
			maxBytes: config.maxIssueChars,
		});
		parts.push(truncation.content);
		if (truncation.truncated) {
			parts.push(
				"",
				`[Issue body truncated: ${truncation.outputLines} of ${truncation.totalLines} lines. ` +
					`View full issue at: ${url}]`,
			);
		}
	} else {
		parts.push(issue.body ?? "");
	}

	if (config.includeComments) {
		// The heading counts what survived filtering, which is what follows it.
		// Cap-driven losses are reported separately, at the gap.
		const filtered = filterComments(issue.comments ?? [], config);
		if (filtered.length > 0) {
			const { kept, omitted, gapAt } = selectComments(
				filtered,
				config.maxComments,
				config.dropComments,
			);
			const marker =
				`[… ${omitted} of ${filtered.length} comments omitted` +
				` — full thread: ${url}]`;
			parts.push(
				"",
				`### Discussion (${filtered.length} comment${filtered.length === 1 ? "" : "s"})`,
				DISCUSSION_FRAMING,
				"",
			);
			kept.forEach((comment, index) => {
				if (omitted > 0 && index === gapAt) parts.push(marker, "");
				parts.push(...formatComment(comment));
			});
			// A cut at the very end has no following comment to trigger the gap.
			if (omitted > 0 && gapAt === kept.length) parts.push(marker, "");
		}
	}

	parts.push(""); // blank line separator between issues
	return parts;
}

// ===========================================================================
// Extension
// ===========================================================================

export default function (pi: ExtensionAPI): void {
	// --- `#` state, populated only when GitHub is actually usable ------------
	const issueBodyCache = new Map<number, CachedIssue>();
	let issueRepo: string | undefined;
	let issueCwd: string | undefined;
	// The last successfully loaded issue list, for synchronous title lookup
	// during completion insertion and as the `alt+g` picker's fallback set.
	let loadedIssues: GitHubIssue[] = [];
	// Installed only in repos where `#` is armed, so a non-GitHub repo keeps
	// pi's stock editor.
	let mentionsEditor: MentionsEditor | undefined;
	let loadErrorShown = false;
	let loadSuccessShown = false;
	let projectWarningShown = false;

	// -----------------------------------------------------------------------
	// Session lifetime
	// -----------------------------------------------------------------------
	//
	// Pi invalidates every ctx it handed out when the session is replaced
	// (`/new`, `/resume`, fork, reload) — touching `ctx.ui` afterwards throws.
	// Two of our callers outlive the session: the editor's post-keystroke timer
	// (a `/new` submitted from the editor lands in exactly that window) and the
	// in-flight `gh issue list`. Both would throw from a timer or a floating
	// promise, which pi has nowhere to catch and turns into a fatal
	// uncaughtException. `session_shutdown` fires before the invalidation, so
	// flipping this flag there is enough to make them stand down in time.

	let sessionActive = true;

	pi.on("session_shutdown", () => {
		sessionActive = false;
		if (mentionsEditor) mentionsEditor.onSelectionMaybeChanged = undefined;
		mentionsEditor = undefined;
	});

	// -----------------------------------------------------------------------
	// session_start: probe capabilities, register the mention providers
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// A fresh session gets a fresh extension instance today, so this is only
		// belt and braces — but a reused instance must not stay shut down.
		sessionActive = true;
		const cwd = ctx.cwd;

		/** `ctx.ui` is only safe while this session still owns the UI. */
		const notify = (message: string, level: "info" | "warning" | "error"): void => {
			if (!sessionActive) return;
			ctx.ui.notify(message, level);
		};

		// `@` first, and never gated on anything GitHub-related: a plain git
		// repo with no remote and no `gh` installed must still get `@`.
		const gitCheck = await runGit(pi, ["rev-parse", "--is-inside-work-tree"], cwd);
		const gitAvailable = gitCheck.code === 0 && gitCheck.stdout.trim() === "true";
		ctx.ui.addAutocompleteProvider((current) =>
			createMentionProvider(current, createGitMentionSpec(pi, cwd, gitAvailable)),
		);

		// `#` only when there is a GitHub remote *and* a usable `gh`. Failing
		// either check is silent — absence of GitHub is not an error worth a
		// notification on every session in a non-GitHub repo.
		const repo = await resolveGitHubRepo(pi, cwd);
		if (repo === undefined) return;
		if (!(await isGhUsable(pi, cwd))) return;

		issueRepo = repo;
		issueCwd = cwd;

		let issuesPromise: Promise<GitHubIssue[] | undefined> | undefined;

		type IssueListFailure =
			| { kind: "exec"; result: ExecResult }
			| { kind: "parse" };

		const loadIssues = async (): Promise<GitHubIssue[] | undefined> => {
			let lastFailure: IssueListFailure | undefined;

			for (let attempt = 0; attempt < GH_LIST_ATTEMPTS; attempt += 1) {
				// A prior attempt may finish after /new, /resume, fork, or reload.
				// Do not call pi.exec again through the now-stale extension runtime.
				if (!sessionActive) return undefined;

				const listIssues = (fields: string): Promise<ExecResult> =>
					pi.exec(
						"gh",
						[
							"issue",
							"list",
							"--repo",
							repo,
							"--state",
							"open",
							"--limit",
							String(MAX_ISSUES),
							"--json",
							fields,
						],
						{ cwd, timeout: GH_LIST_TIMEOUT_MS },
					);

				let result = await listIssues("number,title,assignees,labels,projectItems");

				// The session can be replaced while the subprocess is in flight.
				if (!sessionActive) return undefined;

				if (!execSucceeded(result)) {
					// A normal gh failure can be a missing read:project scope or a host
					// without Project V2 support. Retry without projectItems so labels
					// and ordinary issue completion remain available. Timeouts retain
					// the existing retry policy instead of doubling network work.
					if (!result.killed) {
						const projectError = execFailureDetails(result, GH_LIST_TIMEOUT_MS);
						const fallback = await listIssues("number,title,assignees,labels");
						if (!sessionActive) return undefined;
						if (execSucceeded(fallback)) {
							result = fallback;
							if (!projectWarningShown) {
								projectWarningShown = true;
								notify(
									`mentions: project metadata unavailable; showing issues with labels only (${projectError})`,
									"warning",
								);
							}
						} else {
							lastFailure = { kind: "exec", result: fallback };
							continue;
						}
					} else {
						lastFailure = { kind: "exec", result };
						continue;
					}
				}

				try {
					const issues = JSON.parse(result.stdout) as GitHubIssue[];
					loadedIssues = issues;
					if (!loadSuccessShown && issues.length > 0) {
						loadSuccessShown = true;
						notify(`mentions: ${issues.length} open issues loaded from ${repo}`, "info");
					}
					return issues;
				} catch {
					lastFailure = { kind: "parse" };
				}
			}

			if (!loadErrorShown && lastFailure) {
				loadErrorShown = true;
				if (lastFailure.kind === "parse") {
					notify("mentions: failed to parse gh issue list output", "error");
				} else {
					const details = execFailureDetails(lastFailure.result, GH_LIST_TIMEOUT_MS);
					notify(`mentions: failed to load issues: ${details}`, "error");
				}
			}
			return undefined;
		};

		const getIssues = (): Promise<GitHubIssue[] | undefined> => {
			if (issuesPromise) return issuesPromise;

			const attempt = loadIssues();
			issuesPromise = attempt;
			// A successful result remains cached. A failed load is evicted so a
			// later `#` request can recover without requiring /reload. Identity
			// protects a newer in-flight request from an older completion.
			void attempt.then(
				(issues) => {
					if (issues === undefined && issuesPromise === attempt) issuesPromise = undefined;
				},
				() => {
					if (issuesPromise === attempt) issuesPromise = undefined;
				},
			);
			return attempt;
		};

		// Warm the list so the first `#` keystroke is instant.
		void getIssues();

		// Selecting an issue pre-fetches its body so submitting the prompt does
		// not have to wait on the network.
		const onIssueSelected = (issueNumber: number) => {
			const wantComments = loadConfig(cwd).includeComments;
			const cached = issueBodyCache.get(issueNumber);
			// A hit that was fetched without comments cannot satisfy a config that
			// now wants them — otherwise flipping `includeComments` on mid-session
			// keeps serving the comment-free copy until pi restarts.
			if (cached && (cached.withComments || !wantComments)) return;
			void fetchIssueBody(pi, repo, issueNumber, cwd, wantComments).then((issue) => {
				if (issue) issueBodyCache.set(issueNumber, { issue, withComments: wantComments });
			});
		};

		const lookupIssue = (issueNumber: number): GitHubIssue | undefined =>
			loadedIssues.find((issue) => issue.number === issueNumber);

		const colorMode = ctx.ui.theme.getColorMode();
		ctx.ui.addAutocompleteProvider((current) =>
			createMentionProvider(
				current,
				createIssueMentionSpec(getIssues, lookupIssue, onIssueSelected, colorMode),
			),
		);

		// Only now, with `#` armed, swap in the editor that can report the
		// popup's highlighted row.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new MentionsEditor(tui, theme, keybindings);
			editor.onSelectionMaybeChanged = () => refreshOpenIssueHint(ctx);
			mentionsEditor = editor;
			return editor;
		});
	});

	// -----------------------------------------------------------------------
	// alt+g: open an issue in the browser
	// -----------------------------------------------------------------------
	//
	// Targets, in order: the row highlighted in the `#` popup, then a
	// `[#N - Title]` reference in the prompt, then a picker over the loaded
	// issue list. So the key does something useful from any of the three states
	// the user can be in when they want to look at an issue.
	//
	// `--web` gets cross-platform browser launching for free, and `gh` is
	// guaranteed present here because `issueRepo` is only set after `isGhUsable`
	// passed. `pi.exec` resolves on process exit rather than waiting on the
	// inherited stdio handles, so a browser holding them open does not hang it.

	/** The issue highlighted in the popup, when the popup is showing issues. */
	const highlightedIssueNumber = (): number | undefined => {
		const item = mentionsEditor?.getHighlightedItem();
		// Commit/file rows are `@…`; only `#N` rows are issues.
		if (!item || !item.value.startsWith("#")) return undefined;
		const number = Number.parseInt(item.value.slice(1), 10);
		return Number.isNaN(number) ? undefined : number;
	};

	const openIssue = async (ctx: ExtensionContext, issueNumber: number): Promise<void> => {
		const result = await pi.exec(
			"gh",
			["issue", "view", String(issueNumber), "--repo", issueRepo!, "--web"],
			{ cwd: issueCwd!, timeout: GH_VIEW_TIMEOUT_MS },
		);
		if (!execSucceeded(result)) {
			const details = execFailureDetails(result, GH_VIEW_TIMEOUT_MS);
			ctx.ui.notify(`mentions: failed to open issue #${issueNumber}: ${details}`, "error");
			return;
		}
		ctx.ui.notify(`mentions: opened issue #${issueNumber} in the browser`, "info");
	};

	/** Ask which of several issues to open. Returns undefined when cancelled. */
	const pickIssue = async (
		ctx: ExtensionContext,
		choices: IssueRef[],
	): Promise<number | undefined> => {
		const labels = choices.map((choice) => `#${choice.number} - ${choice.title}`);
		const chosen = await ctx.ui.select("Open issue in browser", labels);
		const index = chosen === undefined ? -1 : labels.indexOf(chosen);
		return index === -1 ? undefined : choices[index]!.number;
	};

	/**
	 * One dim line under the editor, so the key is discoverable rather than
	 * something you have to already know about. Shown only when it would do
	 * something: an issue highlighted in the popup, or referenced in the prompt.
	 */
	const refreshOpenIssueHint = (ctx: ExtensionContext): void => {
		// Reached from a timer after the session was torn down: the ctx is stale
		// and the widget belongs to a UI pi has already cleared.
		if (!sessionActive) return;
		const applies =
			issueRepo !== undefined &&
			(highlightedIssueNumber() !== undefined ||
				collectIssueRefs(ctx.ui.getEditorText()).length > 0);
		ctx.ui.setWidget(
			OPEN_ISSUE_HINT_KEY,
			applies ? [rawKeyHint(OPEN_ISSUE_KEY, "open on GitHub")] : undefined,
			{ placement: "belowEditor" },
		);
	};

	pi.registerShortcut(OPEN_ISSUE_KEY, {
		description: "Open GitHub issue in browser",
		handler: async (ctx) => {
			// No GitHub in this repo: silent, exactly like the absent `#` provider.
			if (!issueRepo || !issueCwd) return;

			const highlighted = highlightedIssueNumber();
			if (highlighted !== undefined) {
				await openIssue(ctx, highlighted);
				return;
			}

			const refs = collectIssueRefs(ctx.ui.getEditorText());
			if (refs.length === 1) {
				await openIssue(ctx, refs[0]!.number);
				return;
			}
			if (refs.length > 1) {
				const chosen = await pickIssue(ctx, refs);
				if (chosen !== undefined) await openIssue(ctx, chosen);
				return;
			}

			// Nothing referenced yet: offer the issues already loaded for `#`,
			// which is the list the user was looking at anyway.
			if (loadedIssues.length === 0) {
				ctx.ui.notify("mentions: no issue reference in the prompt", "info");
				return;
			}
			const chosen = await pickIssue(ctx, loadedIssues);
			if (chosen !== undefined) await openIssue(ctx, chosen);
		},
	});

	// -----------------------------------------------------------------------
	// `@` injection: rewrite the prompt in place, before expansion
	// -----------------------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		// Extension-injected messages are already authored; print/json modes have
		// no way to surface a failure notification.
		if (event.source === "extension" || !ctx.hasUI) return { action: "continue" };

		const tokens = collectGitTokens(event.text);
		if (tokens.length === 0) return { action: "continue" };

		const cwd = ctx.cwd;

		// Resolve each unique reference exactly once (dedupe git fetches).
		let uncommittedBlock: string | undefined;
		const commitBlocks = new Map<string, string>();

		for (const token of tokens) {
			if (token.type === "uncommitted") {
				if (uncommittedBlock === undefined) {
					const result = await fetchUncommitted(pi, cwd);
					if ("error" in result) {
						ctx.ui.notify(`mentions: @uncommitted — ${result.error}`, "error");
						return { action: "handled" };
					}
					uncommittedBlock = buildUncommittedBlock(result, cwd);
				}
			} else {
				if (!commitBlocks.has(token.hash)) {
					const output = await fetchCommit(pi, cwd, token.hash);
					if (output === null) {
						ctx.ui.notify(`mentions: commit ${token.hash} not found`, "error");
						return { action: "handled" };
					}
					commitBlocks.set(token.hash, buildCommitBlock(token.hash, output, cwd));
				}
			}
		}

		// Splice blocks in reverse order so earlier indices stay valid.
		let transformed = event.text;
		const sorted = [...tokens].sort((a, b) => b.start - a.start);
		for (const token of sorted) {
			const block =
				token.type === "uncommitted" ? uncommittedBlock! : commitBlocks.get(token.hash)!;
			transformed = transformed.slice(0, token.start) + block + transformed.slice(token.end);
		}

		return { action: "transform", text: transformed };
	});

	// -----------------------------------------------------------------------
	// `#` injection: append issue bodies as their own collapsed message
	// -----------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		if (!issueRepo || !issueCwd) return;

		const numbers = collectIssueRefs(event.prompt ?? "").map((ref) => ref.number);
		if (numbers.length === 0) return;

		const config = loadConfig(issueCwd);
		const parts: string[] = [];
		for (const number of numbers) {
			const cached = issueBodyCache.get(number);
			// Same staleness rule as the prefetch: a comment-free cache entry is a
			// miss once the config asks for comments.
			let issue =
				cached && (cached.withComments || !config.includeComments)
					? cached.issue
					: undefined;
			if (!issue) {
				// Not pre-fetched (typed by hand, or resumed session): fetch now.
				issue =
					(await fetchIssueBody(
						pi,
						issueRepo,
						number,
						issueCwd,
						config.includeComments,
					)) ?? undefined;
				if (issue) {
					issueBodyCache.set(number, { issue, withComments: config.includeComments });
				}
			}
			if (issue) parts.push(...buildIssueBlock(issueRepo, number, issue, config));
		}

		if (parts.length === 0) return;

		return {
			message: {
				customType: ISSUE_MESSAGE_TYPE,
				content: parts.join("\n"),
				display: true,
			},
		};
	});

	// -----------------------------------------------------------------------
	// Rendering for the injected issue message
	// -----------------------------------------------------------------------

	const renderIssueMessage: MessageRenderer = (message, options, theme) => {
		let text = theme.fg("accent", theme.bold("📋 Referenced GitHub Issues"));
		if (options.expanded) {
			text += "\n" + theme.fg("dim", String(message.content));
		} else {
			text += " " + theme.fg("dim", "(collapsed — Ctrl+O to expand)");
		}
		return new Text(text, 0, 0);
	};

	pi.registerMessageRenderer(ISSUE_MESSAGE_TYPE, renderIssueMessage);
	// Sessions recorded before the git-at/github-issue-reference merge.
	pi.registerMessageRenderer(LEGACY_ISSUE_MESSAGE_TYPE, renderIssueMessage);
}
