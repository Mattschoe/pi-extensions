/**
 * Skill Manager Extension (pi-skill-manager)
 *
 * Provides a /skills command to toggle skill visibility.
 * Skills marked "hidden" get `disable-model-invocation: true` in their SKILL.md,
 * removing them from the system prompt while keeping them loadable via /skill:name.
 *
 * Usage:
 *   /skills              Open the skill manager TUI
 *   ↑↓                   Navigate skills
 *   Enter / Space        Toggle visible ↔ hidden
 *   Esc                  Close
 *
 * Note: toggling rewrites the SKILL.md frontmatter in place, wherever that file
 * lives — including the two global roots outside the current project. See
 * `getSkillRoots` for everything that is scanned.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillInfo {
	name: string;
	path: string; // Absolute path to SKILL.md
	hidden: boolean;
}

// ── Skill discovery ──────────────────────────────────────────────────────────

/** Directories scanned recursively for skill dirs (dirs containing SKILL.md). */
function getSkillRoots(cwd: string): string[] {
	const roots: string[] = [
		path.join(os.homedir(), ".agents", "skills"),
		path.join(os.homedir(), ".pi", "agent", "skills"),
		path.join(cwd, ".agents", "skills"),
		path.join(cwd, ".pi", "skills"),
	];

	// Walk up ancestor directories for .agents/skills (stop at git root or fs root)
	let current = path.resolve(cwd);
	while (true) {
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
		roots.push(path.join(current, ".agents", "skills"));
		if (fs.existsSync(path.join(current, ".git"))) break;
	}

	return roots.filter((r) => fs.existsSync(r));
}

/** Recursively scan a root directory for SKILL.md files. */
function scanRoot(root: string, skills: SkillInfo[], seen: Set<string>): void {
	const queue = [root];
	while (queue.length > 0) {
		const dir = queue.shift()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // permission error or missing
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			const skillMd = path.join(full, "SKILL.md");
			if (fs.existsSync(skillMd)) {
				const info = readSkill(skillMd);
				if (info && !seen.has(info.name)) {
					seen.add(info.name);
					skills.push(info);
				}
			}
			// Always recurse (skill dirs can be nested)
			queue.push(full);
		}
	}
}

function discoverSkills(cwd: string): SkillInfo[] {
	const skills: SkillInfo[] = [];
	const seen = new Set<string>();
	for (const root of getSkillRoots(cwd)) {
		scanRoot(root, skills, seen);
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ── SKILL.md read / write ────────────────────────────────────────────────────

interface Frontmatter {
	data: Record<string, unknown>;
	/** Start offset of the body (after the closing ---). */
	bodyOffset: number;
}

function parseFrontmatter(content: string): Frontmatter {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return { data: {}, bodyOffset: 0 };

	const fmText = match[1]!;
	const bodyOffset = match[0].length;
	const data: Record<string, unknown> = {};

	for (const line of fmText.split("\n")) {
		const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
		if (!m) continue;
		let val: unknown = m[2]!.trim();
		if (val === "true") val = true;
		else if (val === "false") val = false;
		data[m[1]!] = val;
	}

	return { data, bodyOffset };
}

function readSkill(filePath: string): SkillInfo | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const fm = parseFrontmatter(content);
		const name = fm.data["name"];
		if (typeof name !== "string" || !name) return null;
		return {
			name,
			path: filePath,
			hidden: fm.data["disable-model-invocation"] === true,
		};
	} catch {
		return null;
	}
}

/**
 * Toggle `disable-model-invocation` in the SKILL.md frontmatter.
 * Returns true on success.
 */
function setSkillHidden(skillPath: string, hidden: boolean): boolean {
	try {
		const content = fs.readFileSync(skillPath, "utf-8");
		const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!fmMatch) return false;

		const body = content.slice(fmMatch[0].length);
		let fmText = fmMatch[1]!;
		const hasField = /^disable-model-invocation:/m.test(fmText);

		if (hidden) {
			if (hasField) {
				fmText = fmText.replace(
					/^disable-model-invocation:\s*.*$/m,
					"disable-model-invocation: true",
				);
			} else {
				fmText = fmText.trimEnd() + "\ndisable-model-invocation: true";
			}
		} else {
			// Remove the line entirely
			fmText = fmText
				.split("\n")
				.filter((line) => !/^disable-model-invocation:/.test(line))
				.join("\n");
		}

		// Preserve original line-endings
		const nl = content.includes("\r\n") ? "\r\n" : "\n";
		const newContent = `---${nl}${fmText}${nl}---${body}`;
		fs.writeFileSync(skillPath, newContent, "utf-8");
		return true;
	} catch {
		return false;
	}
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function skillManager(pi: ExtensionAPI) {
	pi.registerCommand("skills", {
		description: "Show / hide skills (toggle visibility)",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const skills = discoverSkills(ctx.cwd);

			if (skills.length === 0) {
				ctx.ui.notify("No skills found.", "info");
				return;
			}

			let changed = false;

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = skills.map((s) => ({
					id: s.name,
					label: s.name,
					currentValue: s.hidden ? "hidden" : "visible",
					values: ["visible", "hidden"],
				}));

				const container = new Container();

				// Header (inline component — no dedicated class needed)
				container.addChild(
					new (class {
						render(_w: number) {
							return [
								theme.fg("accent", theme.bold("Skill Manager")),
								theme.fg(
									"dim",
									"↑↓ navigate  •  enter/space toggle  •  esc close",
								),
								theme.fg("dim", `Managing ${skills.length} skills`),
								"",
							];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 4, 20),
					getSettingsListTheme(),
					(id, newValue) => {
						const skill = skills.find((s) => s.name === id);
						if (!skill) return;
						const hidden = newValue === "hidden";
						if (setSkillHidden(skill.path, hidden)) {
							skill.hidden = hidden;
							changed = true;
						} else {
							ctx.ui.notify(`Failed to update ${id}`, "error");
						}
					},
					() => done(undefined),
					{ enableSearch: true },
				);

				container.addChild(settingsList);

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});

			if (changed) {
				ctx.ui.notify(
					"Skills updated — run /reload to apply changes.",
					"info",
				);
			}
		},
	});
}
