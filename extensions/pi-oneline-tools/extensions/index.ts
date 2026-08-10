// One-line tool rendering (pi-oneline-tools)
//
// Re-registers the built-in read/grep/find/ls/bash tools with
// `renderShell: "self"` and a one-line renderCall/renderResult, so a turn full
// of lookups stays one line per lookup instead of a screen of boxes. Expanding
// a row (ctrl+o) puts the full output back under the summary line.
//
// Because this replaces the builtin tool *definitions*, it conflicts with any
// other extension that overrides the same five tools; the last one loaded wins.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadTool,
  createBashTool,
  createLsTool,
  createGrepTool,
  createFindTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "os";
import path from "path";

// ── helpers ─────────────────────────────────────────────────────────────────

const HOME = homedir();
const cwd = process.cwd();

/**
 * The renderer contract, structurally. Pi's own types are not imported because
 * these are the only three shapes this file touches, and spelling them out
 * keeps the helper below independent of which of them pi exports.
 */
type RenderOptions = { expanded?: boolean; isPartial?: boolean };
type ThemeLike = { fg(style: string, text: string): string };
type ToolResultLike = { content?: unknown; isError?: boolean };

function compactPath(p: string): string {
  const resolved = p.startsWith("/") ? p : path.resolve(cwd, p);
  if (resolved.startsWith(HOME)) return "~" + resolved.slice(HOME.length);
  return resolved;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      blocks.push((block as { text: string }).text);
    }
  }
  return blocks;
}

function countLines(content: unknown): number {
  const first = textBlocks(content)[0];
  return first === undefined ? 0 : first.split("\n").length;
}

function shortCmd(command: string, maxLen = 35): string {
  const firstLine = command.split("\n")[0]!.trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 3) + "...";
}

function arg(context: { args?: unknown } | undefined, name: string, fallback: string): string {
  const args = context?.args as Record<string, unknown> | undefined;
  return String(args?.[name] ?? fallback);
}

/**
 * The summary line, plus the tool's own output underneath it when expanded.
 *
 * The full output is reproduced here rather than delegated to the builtin
 * renderer because there is nothing to delegate to: the builtin tool
 * definitions carry no `renderResult` at all (pi renders results without one
 * generically, in tool-execution.ts), and pi uses *our* renderer
 * unconditionally once we define it. Delegating would render an empty
 * component, i.e. expanding a row would make it disappear.
 */
function renderRow(
  summary: string,
  result: ToolResultLike,
  options: RenderOptions,
  theme: ThemeLike,
): Text {
  const line = theme.fg(result.isError ? "error" : "dim", summary);
  if (!options.expanded) return new Text(line, 0, 0);
  const body = textBlocks(result.content).join("\n");
  return new Text(body === "" ? line : `${line}\n${body}`, 0, 0);
}

// ── wiring ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ═══════════════════════════════════════════════════════════════════════════
  //  read — compact, no box
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...createReadTool(cwd),
    renderShell: "self",
    renderCall(args, theme, _context) {
      const p = compactPath(String((args as Record<string, unknown>).path ?? "?"));
      return new Text(theme.fg("dim", `read ${p}...`), 0, 0);
    },
    renderResult(result, options, theme, context) {
      const p = compactPath(arg(context, "path", "?"));
      const lines = countLines(result.content);
      const suffix = result.isError ? `— error (${lines} lines)` : `(${lines} lines)`;
      return renderRow(`read ${p} ${suffix}`, result, options, theme);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  grep — compact, no box
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...createGrepTool(cwd),
    renderShell: "self",
    renderCall(args, theme, _context) {
      const pattern = String((args as Record<string, unknown>).pattern ?? "?");
      return new Text(theme.fg("dim", `grep "${pattern}"...`), 0, 0);
    },
    renderResult(result, options, theme, context) {
      const pattern = arg(context, "pattern", "?");
      const lines = countLines(result.content);
      const suffix = result.isError ? `— error (${lines} lines)` : `(${lines} matches)`;
      return renderRow(`grep "${pattern}" ${suffix}`, result, options, theme);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  find — compact, no box
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...createFindTool(cwd),
    renderShell: "self",
    renderCall(args, theme, _context) {
      const pattern = String((args as Record<string, unknown>).pattern ?? "?");
      return new Text(theme.fg("dim", `find "${pattern}"...`), 0, 0);
    },
    renderResult(result, options, theme, context) {
      const pattern = arg(context, "pattern", "?");
      const lines = countLines(result.content);
      const suffix = result.isError ? `— error (${lines} lines)` : `(${lines} matches)`;
      return renderRow(`find "${pattern}" ${suffix}`, result, options, theme);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  ls — compact, no box
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...createLsTool(cwd),
    renderShell: "self",
    renderCall(args, theme, _context) {
      const p = compactPath(String((args as Record<string, unknown>).path ?? "."));
      return new Text(theme.fg("dim", `ls ${p}...`), 0, 0);
    },
    renderResult(result, options, theme, context) {
      const p = compactPath(arg(context, "path", "."));
      const lines = countLines(result.content);
      const suffix = result.isError ? `— error (${lines} lines)` : `(${lines} entries)`;
      return renderRow(`ls ${p} ${suffix}`, result, options, theme);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  bash — compact, no box
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...createBashTool(cwd),
    renderShell: "self",
    renderCall(args, theme, _context) {
      const cmd = String((args as Record<string, unknown>).command ?? "bash");
      return new Text(theme.fg("dim", `${shortCmd(cmd)}...`), 0, 0);
    },
    renderResult(result, options, theme, context) {
      const cmd = arg(context, "command", "bash");
      const lines = countLines(result.content);
      const suffix = result.isError ? `— error (${lines} lines)` : `(${lines} lines)`;
      return renderRow(`${shortCmd(cmd)} ${suffix}`, result, options, theme);
    },
  });
}
