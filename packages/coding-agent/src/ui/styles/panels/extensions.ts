/**
 * The extension control center's terminal look: a box titled "Extension
 * Control Center" holding the provider tabs, the inventory list beside the
 * inspector, and the key hints; the list and the inspector also draw alone
 * (roles `omp.extensions.list`, `omp.extensions.inspector`).
 */
import * as os from "node:os";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { inputLine } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import { padTo, replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import {
	sanitizeDisplayField,
	sanitizeDisplayLine,
	sanitizeDisplayLineField,
	sanitizeDisplayText,
} from "../../../extensibility/inventory/display-text";
import type { MCPConnectionHealth } from "../../../extensibility/inventory/mcp-runtime";
import { snapshotMcpRuntime } from "../../../extensibility/inventory/mcp-runtime";
import { type Extension, type ExtensionState, isShadowedExtension } from "../../../extensibility/inventory/types";
import type { ExtensionDashboardModel, ProviderTabView } from "../../overlays/panels/extensions-dashboard-model";
import {
	clampOffset,
	type ExtensionListModel,
	type ListRow,
	scrollToShow,
} from "../../overlays/panels/extension-list-model";
import type { ExtensionInspectorModel } from "../../overlays/panels/extension-inspector-model";
import {
	CATALOG_ITEMS,
	catalogWindow,
	commandData,
	contentData,
	DESCRIPTION_LINES,
	enablementLabel,
	hookData,
	INLINE_ARGS,
	isDiscoveredMcpServer,
	LIST_ITEMS,
	liveToolsFor,
	mcpHealthLabel,
	PREVIEW_LINES,
	rowHint,
	ruleData,
	skillData,
	snapshotTools,
	type ToolParam,
	toolData,
	toolParams,
} from "../../overlays/panels/extensions-data";
import { shortenPath } from "../../../utils/render-utils";
import { keyGlyph, termOf } from "./common";

// ─── Shared ─────────────────────────────────────────────────────────────────

/** A scrolled window of `rows`: a scrollbar in the last column while `total` overflows `height`. */
function scrolled(
	theme: Theme,
	rows: readonly string[],
	width: number,
	total: number,
	offset: number,
	track = "muted",
): string[] {
	const height = rows.length;
	if (total <= height || height === 0 || width <= 0) return rows.map(row => truncate(replaceTabs(row), width, "…"));
	const content = Math.max(0, width - 1);
	const size = Math.max(1, Math.min(Math.floor((height * height) / total), height));
	const max = Math.max(0, total - height);
	const at = clampOffset(offset, total, height);
	const start = max === 0 ? 0 : Math.round((at / max) * (height - size));
	return rows.map((row, i) => {
		const line = truncate(replaceTabs(row), content, "…");
		const bar = i >= start && i < start + size ? theme.fg("accent", "█") : theme.fg(track, "│");
		return `${padTo(line, content)}${bar}`;
	});
}

// ─── List ───────────────────────────────────────────────────────────────────

function stateIcon(theme: Theme, state: ExtensionState, masterOff: boolean): string {
	const status = (key: string) => theme.symbols.symbol(`status.${key}`);
	if (masterOff) return theme.fg("dim", status("disabled"));
	if (state === "active") return theme.fg("success", status("enabled"));
	if (state === "disabled") return theme.fg("dim", status("disabled"));
	return theme.fg("warning", status("shadowed"));
}

function healthIcon(theme: Theme, health: MCPConnectionHealth, masterOff: boolean): string {
	const status = (key: string) => theme.symbols.symbol(`status.${key}`);
	if (masterOff) return theme.fg("dim", status("disabled"));
	switch (health) {
		case "connected":
			return theme.fg("success", status("enabled"));
		case "connecting":
			return theme.fg("muted", status("running"));
		case "disconnected":
			return theme.fg("dim", status("shadowed"));
		case "inactive":
			return theme.fg("warning", status("disabled"));
	}
}

function listRow(
	model: ExtensionListModel,
	row: ListRow,
	selected: boolean,
	width: number,
	theme: Theme,
	masterOff: boolean,
): string {
	const picked = (line: string) => theme.bg("selectedBg", theme.style("strong", theme.fg("accent", line)));
	const check = (on: boolean) =>
		on
			? theme.fg("success", theme.symbols.symbol("checkbox.checked"))
			: theme.fg("dim", theme.symbols.symbol("checkbox.unchecked"));
	switch (row.type) {
		case "master": {
			let line = `${check(row.enabled)} ${theme.symbols.symbol("icon.package")} Enable ${row.providerName}  ${theme.fg("warning", "(Master Switch)")}`;
			if (selected) line = picked(line);
			else if (!row.enabled) line = theme.fg("dim", line);
			return truncate(line, width, "…");
		}
		case "user-source": {
			let line = `${check(row.enabled)} ${theme.symbols.symbol("icon.folder")} Load ~/ ${row.providerName} config  ${theme.fg("muted", "(opt-in; project config always loads)")}`;
			if (selected) line = picked(line);
			else if (!row.enabled || masterOff) line = theme.fg("dim", line);
			return truncate(line, width, "…");
		}
		case "kind-header": {
			const line = `${theme.symbols.symbol(row.icon)} ${row.label} ${theme.fg("muted", `(${row.count})`)}`;
			return truncate(selected ? picked(line) : theme.fg("muted", line), width, "…");
		}
		case "extension": {
			const ext = row.item;
			const shadowed = isShadowedExtension(ext);
			const off = masterOff || ext.state === "disabled";
			const mcp = model.mcpSnapshot(ext, shadowed, off);
			const icon = shadowed
				? stateIcon(theme, "shadowed", masterOff)
				: mcp
					? healthIcon(theme, mcp.health, masterOff)
					: stateIcon(theme, ext.state, masterOff);
			let name = sanitizeDisplayLine(ext.displayName);
			if (selected && !masterOff) name = theme.style("strong", theme.fg("accent", name));
			else if (off) name = theme.fg("dim", name);
			else if (shadowed) name = theme.fg("warning", name);
			const nameWidth = Math.min(24, width - 16);
			let line = `   ${icon} ${visibleWidth(name) >= nameWidth ? truncate(name, nameWidth, "…") : padTo(name, nameWidth)}`;
			const hint = rowHint(ext, mcp, snapshotTools(model.toolSource));
			if (hint) {
				const tone = off
					? "dim"
					: mcp?.health === "inactive"
						? "warning"
						: mcp?.health === "disconnected"
							? "dim"
							: "muted";
				const room = width - visibleWidth(line) - 2;
				if (room > 5) line += `  ${truncate(theme.fg(tone, sanitizeDisplayLine(hint)), room, "…")}`;
			}
			if (selected) line = theme.bg("selectedBg", line);
			return truncate(line, width, "…");
		}
	}
}

/** The list's face: the search field, a blank row, then the window of rows. */
export function listRows(
	model: ExtensionListModel,
	width: number,
	theme: Theme,
	maxVisible = model.maxVisible,
): string[] {
	const prefix = theme.fg("muted", "Search: ");
	const { text, cursor } = model.search;
	const lines = [
		model.focused
			? `${prefix}${inputLine(text, cursor, Math.min(Math.max(1, width - visibleWidth(prefix)), visibleWidth(text) + 1), "")}`
			: `${prefix}${text || theme.fg("dim", "type to filter")}`,
		"",
	];
	const rows = model.rows;
	if (rows.length === 0) {
		lines.push(theme.fg("muted", "  No extensions found for this provider."));
		return lines;
	}
	const masterOff = model.masterDisabled();
	const offset = scrollToShow(model.scrollOffset, model.selected, rows.length, maxVisible);
	const start = clampOffset(offset, rows.length, maxVisible);
	const end = Math.min(rows.length, start + Math.max(0, maxVisible));
	const rowWidth = Math.max(0, width - (rows.length > maxVisible ? 1 : 0));
	const shown: string[] = [];
	for (let i = start; i < end; i++) {
		const selected = model.focused && i === model.selected;
		let line = listRow(model, rows[i]!, selected, rowWidth, theme, masterOff);
		if (model.focused && i === model.hovered && !selected) line = theme.bg("selectedBg", line);
		shown.push(line);
	}
	lines.push(...scrolled(theme, shown, width, rows.length, start));
	return lines;
}

// ─── Inspector ──────────────────────────────────────────────────────────────

interface KindRows {
	title?: string;
	description?: string;
	guidance?: string;
	runtimeLine?: string;
	runtimeExtra?: string[];
	surface: string[];
	contents: string[];
	preview?: { heading: string; text: string };
	config: string[];
}

function wrapped(lines: string[], text: string, width: number, indent = ""): void {
	const rows = wrap(replaceTabs(text), Math.max(1, width - indent.length));
	for (const line of rows.length > 0 ? rows : [""]) lines.push(`${indent}${line}`);
}

function labeled(lines: string[], theme: Theme, label: string, value: string, width: number, color = "accent"): void {
	// The label column gives way so the value keeps 8 cells.
	const labelWidth = Math.max(1, Math.min(10, width - 11));
	const shown = visibleWidth(label) > labelWidth ? truncate(label, labelWidth, "…") : padTo(label, labelWidth);
	const rows = wrap(sanitizeDisplayText(value), Math.max(1, width - 3 - labelWidth));
	(rows.length > 0 ? rows : [""]).forEach((row, i) => {
		lines.push(`${i === 0 ? `  ${shown} ` : " ".repeat(labelWidth + 3)}${theme.fg(color, row)}`);
	});
}

function section(theme: Theme, title: string, body: string[], width: number): string[] {
	const rows = body.at(-1) === "" ? body.slice(0, -1) : body;
	return [
		truncate(theme.fg("muted", title.replace(/[\r\n]+/g, " ")), width, ""),
		truncate(theme.fg("dim", "─".repeat(Math.max(0, Math.min(width, 40)))), width, ""),
		...rows.map(line => truncate(line.replace(/[\r\n]+/g, " "), width, "")),
		"",
	];
}

function statusBadge(theme: Theme, state: ExtensionState, reason?: string, shadowedBy?: string): string {
	const status = (key: string) => theme.symbols.symbol(`status.${key}`);
	switch (state) {
		case "active":
			return theme.fg("success", `${status("enabled")} ${enablementLabel(state)}`);
		case "disabled":
			return theme.fg("dim", `${status("disabled")} ${enablementLabel(state, reason)}`);
		case "shadowed":
			return theme.fg("warning", `${status("shadowed")} ${enablementLabel(state, reason, shadowedBy)}`);
	}
}

function params(lines: string[], theme: Theme, list: ToolParam[], width: number, indent: string): void {
	if (list.length === 0) {
		lines.push(`${indent}${theme.fg("dim", "(no arguments)")}`);
		return;
	}
	for (const param of list) {
		lines.push(
			`${indent}${theme.fg("accent", padTo(param.name, 12))} ${theme.fg("muted", padTo(param.type, 10))} ${theme.fg(param.required ? "warning" : "dim", param.flag)}`,
		);
		if (param.description) wrapped(lines, param.description, width, `${indent}  `);
	}
}

function markdownLine(theme: Theme, line: string): string {
	if (/^#{1,6}\s/.test(line)) return theme.style("strong", theme.fg("accent", line));
	if (line.startsWith("```")) return theme.fg("dim", line);
	const bullet = /^(\s*(?:[-*+]|\d+\.)\s)/.exec(line);
	return bullet ? `${theme.fg("accent", bullet[1]!)}${line.slice(bullet[1]!.length)}` : line;
}

function catalogEntry(
	body: string[],
	theme: Theme,
	inspector: ExtensionInspectorModel,
	entry: { name: string; title?: string; description?: string; parameters?: unknown },
	width: number,
): boolean {
	body.push(`  ${theme.fg("accent", entry.name)}`);
	if (entry.title && entry.title !== entry.name) body.push(`    ${theme.fg("muted", entry.title)}`);
	if (entry.description) wrapped(body, entry.description, width, "    ");
	const list = toolParams(entry.parameters);
	let collapsed = false;
	if (inspector.expanded || list.length <= INLINE_ARGS) params(body, theme, list, width, "    ");
	else if (list.length > 0) {
		collapsed = true;
		body.push(`    ${theme.fg("dim", `${list.length} args`)}`);
	}
	body.push("");
	return collapsed;
}

function kindRows(
	inspector: ExtensionInspectorModel,
	ext: Extension,
	width: number,
	theme: Theme,
	expandKey: string,
): KindRows {
	const more = (hidden: number) => theme.fg("dim", `  … ${hidden} more (${expandKey} to expand)`);
	const home = os.homedir();
	switch (ext.kind) {
		case "mcp": {
			const shadowed = isShadowedExtension(ext);
			if (shadowed) {
				const config: string[] = [];
				if (isDiscoveredMcpServer(ext.raw) && ext.raw.command)
					labeled(config, theme, "Command", shortenPath(ext.raw.command, home), width, "success");
				if (config.length > 0) config.push("");
				return { surface: [], contents: [], config };
			}
			const snap = isDiscoveredMcpServer(ext.raw)
				? snapshotMcpRuntime(ext.raw, inspector.mcpSource, { enabled: ext.state !== "disabled" })
				: undefined;
			const health = snap?.health ?? "disconnected";
			const runtimeExtra: string[] = [];
			if (snap?.implementationName) {
				runtimeExtra.push(
					theme.fg(
						"dim",
						`${snap.implementationName}${snap.implementationVersion ? ` ${snap.implementationVersion}` : ""}`,
					),
				);
				if (snap.websiteUrl) runtimeExtra.push(theme.fg("dim", snap.websiteUrl));
			}
			const contents: string[] = [];
			if (snap && snap.tools.length > 0) {
				const body: string[] = [];
				const { shown, hidden } = catalogWindow(snap.tools, inspector.expanded ? snap.tools.length : CATALOG_ITEMS);
				let collapsed = false;
				for (const tool of shown) collapsed = catalogEntry(body, theme, inspector, tool, width) || collapsed;
				if (hidden > 0) body.push(more(hidden), "");
				else if (collapsed) body.push(theme.fg("dim", `  … args (${expandKey} to expand)`), "");
				contents.push(...section(theme, "Tools", body, width));
			}
			for (const [head, entries] of [
				["Resources", snap?.resources ?? []],
				["Prompts", snap?.prompts ?? []],
			] as const) {
				if (entries.length === 0) continue;
				const body: string[] = [];
				const { shown, hidden } = catalogWindow(entries, inspector.expanded ? entries.length : CATALOG_ITEMS);
				for (const entry of shown) body.push(`  ${theme.fg("accent", entry.name)}`);
				if (hidden > 0) body.push(more(hidden));
				body.push("");
				contents.push(...section(theme, head, body, width));
			}
			const config: string[] = [];
			if (snap?.command) labeled(config, theme, "Command", shortenPath(snap.command, home), width, "success");
			if (snap?.url) labeled(config, theme, "URL", snap.url, width, "success");
			if (snap?.args?.length) labeled(config, theme, "Args", snap.args.join(" "), width, "dim");
			if (snap && snap.envCount > 0) labeled(config, theme, "Env vars", `${snap.envCount} defined`, width, "dim");
			if (config.length > 0) config.push("");
			return {
				title: snap?.title,
				description: snap?.description,
				guidance: snap?.instructions,
				runtimeLine: `${healthIcon(theme, health, false)} ${mcpHealthLabel(health)}     ${theme.fg("muted", snap?.transport ?? "stdio")}`,
				runtimeExtra,
				surface: [],
				contents,
				config,
			};
		}
		case "tool": {
			const lives = liveToolsFor(ext, snapshotTools(inspector.toolSource));
			const data = toolData(ext, lives, inspector.source);
			if (data.factory.length > 1) {
				const body: string[] = [];
				let collapsed = false;
				for (const tool of data.factory)
					collapsed =
						catalogEntry(
							body,
							theme,
							inspector,
							{ name: tool.name, title: tool.label, description: tool.description, parameters: tool.parameters },
							width,
						) || collapsed;
				if (collapsed) body.push(theme.fg("dim", `  … args (${expandKey} to expand)`), "");
				return {
					description: data.description,
					surface: section(theme, "Tools", body, width),
					contents: [],
					config: [],
				};
			}
			if (lives.length === 0 && data.params.length === 0)
				return { description: data.description, surface: [], contents: [], config: [] };
			const body: string[] = [];
			params(body, theme, data.params, width, "  ");
			return {
				title: data.label,
				description: data.description,
				surface: section(theme, "Arguments", body, width),
				contents: [],
				config: [],
			};
		}
		case "rule": {
			const data = ruleData(ext, inspector.source);
			const body: string[] = [];
			const list = (label: string, items: string[]) => {
				if (items.length === 1) return labeled(body, theme, label, items[0]!, width);
				const shown = items.slice(0, inspector.expanded ? items.length : LIST_ITEMS);
				const hidden = items.length - shown.length;
				const indent = " ".repeat(13);
				if (hidden > 0) {
					labeled(body, theme, label, `${items.length} patterns`, width, "dim");
					for (const item of shown) wrapped(body, item, width, indent);
					body.push(theme.fg("dim", `${indent}… ${hidden} more (${expandKey} to expand)`));
					return;
				}
				labeled(body, theme, label, shown[0] ?? "", width);
				for (const item of shown.slice(1)) wrapped(body, item, width, indent);
			};
			if (data.alwaysApply) body.push(`  ${theme.fg("accent", "always")}`);
			if (data.globs) labeled(body, theme, "globs", data.globs.join(", "), width);
			if (data.condition) list("condition", data.condition);
			if (data.astCondition) list("ast", data.astCondition);
			if (data.scope) list("scope", data.scope);
			if (data.agents) list("agents", data.agents);
			if (data.interruptMode) labeled(body, theme, "interrupt", data.interruptMode, width, "dim");
			if (!data.alwaysApply && !data.globs && !data.condition && !data.astCondition && !data.agents)
				body.push(theme.fg("dim", "  (no apply conditions)"));
			body.push("");
			return {
				description: data.description,
				surface: section(theme, "Applies", body, width),
				contents: [],
				preview: { heading: "Rule", text: data.content },
				config: [],
			};
		}
		case "skill": {
			const data = skillData(ext);
			const runtimeExtra: string[] = [];
			if (data.hidden) {
				wrapped(
					runtimeExtra,
					`${theme.fg("warning", "hidden")}    omitted from the system-prompt skill list`,
					width,
					"  ",
				);
				const box = theme.symbols.box;
				runtimeExtra.push(
					theme.fg("border", `${box.teeRight}${box.horizontal.repeat(Math.max(0, width - 2))}${box.teeLeft}`),
				);
			}
			const surface: string[] = [];
			if (data.alwaysApply) surface.push(`  ${theme.fg("accent", "always apply")}`);
			if (data.globs) labeled(surface, theme, "globs", data.globs.join(", "), width);
			if (surface.length > 0) surface.push("");
			return {
				description: data.description,
				runtimeExtra: runtimeExtra.length > 0 ? runtimeExtra : undefined,
				surface,
				contents: [],
				preview: { heading: "Instruction", text: data.content },
				config: [],
			};
		}
		case "slash-command": {
			const data = commandData(ext);
			const body = [`  ${theme.fg("accent", `/${sanitizeDisplayText(ext.name)}`)}`];
			if (data.argumentHint) labeled(body, theme, "hint", data.argumentHint, width, "dim");
			if (data.usesArguments) body.push(`  ${theme.fg("dim", "accepts $ARGUMENTS")}`);
			body.push("");
			return {
				description: data.description,
				surface: section(theme, "Invocation", body, width),
				contents: [],
				preview: { heading: "Template", text: data.body },
				config: [],
			};
		}
		case "hook": {
			const data = hookData(ext);
			const body: string[] = [];
			if (data.hookType) labeled(body, theme, "when", data.hookType, width);
			if (data.tool) labeled(body, theme, "tool", data.tool, width);
			body.push("");
			return {
				description: ext.description,
				surface: section(theme, "Hook", body, width),
				contents: [],
				config: [],
			};
		}
		case "prompt":
		case "context-file":
			return {
				description: ext.description,
				surface: [],
				contents: [],
				preview: { heading: ext.kind === "prompt" ? "Prompt" : "Preview", text: contentData(ext).content },
				config: [],
			};
		case "instruction": {
			const data = contentData(ext);
			const surface: string[] = [];
			if (data.applyTo) {
				const body: string[] = [];
				labeled(body, theme, "files", data.applyTo, width);
				body.push("");
				surface.push(...section(theme, "Applies", body, width));
			}
			return {
				description: ext.description,
				surface,
				contents: [],
				preview: { heading: "Instruction", text: data.content },
				config: [],
			};
		}
		default:
			return {
				description: ext.description,
				surface: ext.trigger ? section(theme, "Trigger", [`  ${theme.fg("accent", ext.trigger)}`, ""], width) : [],
				contents: [],
				config: [],
			};
	}
}

/** The inspector's face: identity, runtime and status, description, origin, kind sections, contents, config. */
export function inspectorRows(
	inspector: ExtensionInspectorModel,
	width: number,
	theme: Theme,
	expandKey = keyGlyph("ctrl+o"),
	height = inspector.height,
): string[] {
	const ext = inspector.extension;
	if (!ext) return [theme.fg("muted", "Select an extension"), theme.fg("dim", "to view details")];
	const lines: string[] = [];
	const kind = kindRows(inspector, ext, width, theme, expandKey);
	const name = sanitizeDisplayLine(ext.displayName);
	lines.push(theme.style("strong", theme.fg("accent", name)));
	const title = sanitizeDisplayLineField(kind.title);
	if (title && title !== name) lines.push(theme.fg("muted", title));
	lines.push("");
	if (kind.runtimeLine) {
		lines.push(kind.runtimeLine, ...(kind.runtimeExtra ?? []));
		if (ext.state !== "active") lines.push(`  ${statusBadge(theme, ext.state, ext.disabledReason, ext.shadowedBy)}`);
	} else lines.push(statusBadge(theme, ext.state, ext.disabledReason, ext.shadowedBy), ...(kind.runtimeExtra ?? []));
	lines.push("");
	for (const value of [kind.description, kind.guidance]) {
		const text = sanitizeDisplayField(value);
		if (!text) continue;
		const rows: string[] = [];
		for (const raw of sanitizeDisplayText(text).split("\n")) {
			const folded = wrap(replaceTabs(raw), Math.max(8, width));
			rows.push(...(folded.length > 0 ? folded : [""]));
		}
		if (inspector.expanded || rows.length <= DESCRIPTION_LINES) lines.push(...rows);
		else
			lines.push(
				...rows.slice(0, DESCRIPTION_LINES),
				theme.fg("dim", `  … ${rows.length - DESCRIPTION_LINES} more (${expandKey} to expand)`),
			);
		lines.push("");
	}
	lines.push(theme.fg("muted", "Origin:"));
	const level = ext.source.level === "user" ? "User" : ext.source.level === "project" ? "Project" : "Native";
	wrapped(lines, theme.style("em", `via ${sanitizeDisplayText(ext.source.providerName)} (${level})`), width, "  ");
	wrapped(lines, theme.fg("dim", sanitizeDisplayText(shortenPath(ext.path, os.homedir()))), width, "  ");
	lines.push("", ...kind.surface, ...kind.contents);
	if (kind.preview) {
		const budget = height > 0 ? Math.max(4, height - (lines.length + 2) - (kind.config.length + 1)) : PREVIEW_LINES;
		const body: string[] = [];
		if (!kind.preview.text) body.push(theme.fg("dim", "  (empty)"));
		else {
			const rows: string[] = [];
			for (const raw of sanitizeDisplayText(kind.preview.text).split("\n")) {
				const folded = wrap(markdownLine(theme, raw), Math.max(8, width - 1));
				rows.push(...(folded.length > 0 ? folded : [""]));
			}
			if (inspector.expanded || rows.length <= budget) body.push(...rows);
			else {
				const shown = Math.max(1, budget - 1);
				body.push(
					...rows.slice(0, shown),
					theme.fg("dim", `  … ${rows.length - shown} more (${expandKey} to expand)`),
				);
			}
		}
		lines.push(...section(theme, kind.preview.heading, body, width));
	}
	lines.push(...kind.config);
	return lines;
}

// ─── Tab bar ────────────────────────────────────────────────────────────────

/** The tab bar's rows and where each tab sits (row, columns). */
export function tabBarRows(
	tabs: readonly ProviderTabView[],
	active: number,
	hover: string | null,
	width: number,
	theme: Theme,
): { rows: string[]; zones: { line: number; start: number; end: number; index: number }[] } {
	const max = Math.max(1, width);
	const chunksOf = (labels: readonly string[]) => {
		const chunks: { text: string; index?: number }[] = [];
		tabs.forEach((tab, i) => {
			const style = (text: string) =>
				tab.muted
					? theme.fg("dim", text)
					: i === active
						? theme.style("strong", theme.bg("selectedBg", theme.fg("text", text)))
						: tab.id === hover
							? theme.bg("selectedBg", theme.fg("text", text))
							: theme.fg("muted", text);
			chunks.push({ text: style(` ${labels[i]} `), index: i });
			if (i < tabs.length - 1) chunks.push({ text: "  " });
		});
		return chunks;
	};
	const total = (chunks: { text: string }[]) => chunks.reduce((sum, chunk) => sum + visibleWidth(chunk.text), 0);
	const labels = tabs.map(tab => tab.label);
	let chunks = chunksOf(labels);
	if (total(chunks) > max) {
		const order = tabs
			.map((_, i) => i)
			.filter(i => i !== active)
			.sort((a, b) => Math.abs(b - active) - Math.abs(a - active));
		for (const i of order) {
			labels[i] = tabs[i]!.short;
			chunks = chunksOf(labels);
			if (total(chunks) <= max) break;
		}
	}
	const rows: string[] = [];
	const zones: { line: number; start: number; end: number; index: number }[] = [];
	let line = "";
	let used = 0;
	for (const chunk of chunks) {
		const cells = visibleWidth(chunk.text);
		if (cells <= 0) continue;
		if (cells > max) {
			if (line) rows.push(line);
			line = "";
			used = 0;
			if (chunk.index !== undefined) zones.push({ line: rows.length, start: 0, end: max, index: chunk.index });
			rows.push(truncate(chunk.text, max, "…"));
			continue;
		}
		if (used > 0 && used + cells > max) {
			rows.push(line);
			line = "";
			used = 0;
		}
		if (chunk.index !== undefined)
			zones.push({ line: rows.length, start: used, end: used + cells, index: chunk.index });
		line += chunk.text;
		used += cells;
	}
	if (line) rows.push(line);
	return { rows: rows.length > 0 ? rows : [""], zones };
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

const TITLE = "Extension Control Center";

/** Where the dashboard's parts sit at a width. */
export interface DashboardLayout {
	readonly rows: string[];
	readonly tabRows: number;
	readonly zones: { line: number; start: number; end: number; index: number }[];
	readonly contentRows: number;
	readonly left: number;
	readonly right: number;
	/** Inspector rows (for its scroll range). */
	readonly inspectorTotal: number;
}

export function dashboardLayout(
	model: ExtensionDashboardModel,
	width: number,
	height: number,
	theme: Theme,
): DashboardLayout {
	const box = theme.symbols.box;
	const edge = (text: string) => theme.fg("border", text);
	const inner = Math.max(1, width - 4);
	const row = (content: string) =>
		`${edge(box.vertical)} ${width > 4 ? padTo(truncate(content, width - 4, "…"), width - 4) : ""} ${edge(box.vertical)}`;
	const divider = edge(`${box.teeRight}${box.horizontal.repeat(Math.max(0, width - 2))}${box.teeLeft}`);
	const tabs = tabBarRows(model.tabViews(), model.activeTab, model.hoverTab, inner, theme);
	const contentRows = Math.max(5, Math.max(14, height) - (tabs.rows.length + 5));
	const left = Math.floor(inner / 2);
	const right = Math.max(0, inner - left - 3);
	const list = listRows(model.list, left, theme, Math.max(3, contentRows - 2));
	const detail = inspectorRows(model.inspector, Math.max(0, right - 2), theme, model.expandGlyph, contentRows);
	const scroll = Math.min(model.inspectorScroll, Math.max(0, detail.length - contentRows));
	const window = Array.from({ length: contentRows }, (_, i) => detail[scroll + i] ?? "");
	const shownDetail = scrolled(theme, window, right, detail.length, scroll);
	const rows: string[] = [];
	const shown = truncate(` ${TITLE} `, Math.max(0, width - 4), "…");
	rows.push(
		`${edge(`${box.topLeft}${box.horizontal}`)}${theme.style("strong", theme.fg("accent", shown))}${edge(`${box.horizontal.repeat(Math.max(0, width - 3 - visibleWidth(shown)))}${box.topRight}`)}`,
	);
	for (const line of tabs.rows) rows.push(row(line));
	rows.push(divider);
	for (let i = 0; i < contentRows; i++)
		rows.push(
			row(
				`${padTo(truncate(list[i] ?? "", left, "…"), left)}${theme.fg("dim", ` ${box.vertical} `)}${shownDetail[i] ?? ""}`,
			),
		);
	rows.push(divider);
	rows.push(row(theme.fg("dim", model.footerText())));
	rows.push(edge(`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, width - 2))}${box.bottomRight}`));
	return {
		rows,
		tabRows: tabs.rows.length,
		zones: tabs.zones,
		contentRows,
		left,
		right,
		inspectorTotal: detail.length,
	};
}

// ─── Registration ───────────────────────────────────────────────────────────

defineRolePainter("col", "omp.extensions.list", (node, cx): Block => {
	const list = termOf<{ list: ExtensionListModel }>(node).list;
	if (!list) return { rows: [] };
	list.rev();
	return { rows: listRows(list, cx.width, cx.theme) };
});

defineRolePainter("col", "omp.extensions.inspector", (node, cx): Block => {
	const inspector = termOf<{ inspector: ExtensionInspectorModel }>(node).inspector;
	if (!inspector) return { rows: [] };
	inspector.rev();
	return { rows: inspectorRows(inspector, cx.width, cx.theme) };
});

function dashboardOf(node: UiNode): ExtensionDashboardModel | undefined {
	return termOf<{ dashboard: ExtensionDashboardModel }>(node).dashboard;
}

defineRolePainter("picker", "omp.extensions", (node, cx): Block => {
	const model = dashboardOf(node);
	if (!model || cx.width <= 0) return { rows: [] };
	model.rev();
	const layout = dashboardLayout(model, cx.width, cx.height ?? model.terminal.size().rows, cx.theme);
	return { rows: layout.rows, hits: [{ row: 0, col: 0, width: cx.width, height: layout.rows.length, node }] };
});

defineRoleWidget("picker", "omp.extensions", {
	mouse(node, mouse, at, _cx, hit) {
		const model = dashboardOf(node);
		if (!model) return false;
		model.mouse(dashboardLayout(model, hit.width, hit.height, model.terminal.theme()), mouse, at.row, at.col);
		return true;
	},
});
