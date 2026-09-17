/**
 * InspectorPanel — detail pane for the selected extension.
 *
 * One inspection grammar for every kind:
 * identity → runtime/enablement → description → origin →
 * kind-specific surface → contents → boring config.
 */
import * as os from "node:os";
import type { Component } from "../../tui";
import { visibleWidth, wrapTextWithAnsi } from "../../utils";
import { KeyValueList } from "../../components/key-value-list";
import { Section } from "../../components/section";
import { renderTableRow } from "../../components/table";
import { theme } from "../../theme";
import { expandKeyHint, PREVIEW_LIMITS, replaceTabs, shortenPath } from "../../render/render-utils";
import {
	sanitizeDisplayField,
	sanitizeDisplayLine,
	sanitizeDisplayLineField,
	sanitizeDisplayText,
} from "./display-text";
import {
	commandInspectorData,
	type ExtensionInspectorSource,
	contextInspectorData,
	enablementLabel,
	hookInspectorData,
	instructionInspectorData,
	liveToolsForExtension,
	promptInspectorData,
	ruleInspectorData,
	skillInspectorData,
	type ToolParamView,
	type ToolRuntimeSource,
	toolInspectorData,
	toolParamsFromSchema,
} from "./inspector-model";
import { snapshotToolRuntimeSource } from "./live-tool-session";
import {
	formatMcpHealthLabel,
	isDiscoveredMcpServer,
	type MCPConnectionHealth,
	type MCPRuntimeSource,
	snapshotMcpRuntime,
	visibleMcpTools,
} from "./mcp-runtime";
import { type Extension, type ExtensionState, isShadowedExtension } from "./types";

export type { ToolRuntimeSource };

interface KindView {
	title?: string;
	description?: string;
	/** MCP `initialize.instructions`. Rendered under description, not as a footer. */
	guidance?: string;
	runtimeLine?: string;
	runtimeExtra?: string[];
	surface: string[];
	contents: string[];
	preview?: { heading: string; text: string };
	config: string[];
}

const PREVIEW_LINE_BUDGET = PREVIEW_LIMITS.EXPANDED_LINES;
const MCP_TOOL_BUDGET = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const MCP_INLINE_ARG_LIMIT = 3;
const MCP_INLINE_DESC_LINES = 3;

export class InspectorPanel implements Component {
	#extension: Extension | null = null;
	#extensionKey: string | null = null;
	#mcpSource: MCPRuntimeSource | undefined;
	#toolSource: ToolRuntimeSource | undefined;
	#toolFrame: ToolRuntimeSource | undefined;
	#expanded = false;
	#width = 72;
	#height = 0;

	readonly #source: ExtensionInspectorSource | undefined;

	constructor(source?: ExtensionInspectorSource) {
		this.#source = source;
	}

	setExtension(extension: Extension | null): void {
		const key = inspectorExtensionKey(extension);
		if (key !== this.#extensionKey) {
			this.#expanded = false;
			this.#extensionKey = key;
		}
		this.#extension = extension;
	}

	setMcpSource(source: MCPRuntimeSource | undefined): void {
		this.#mcpSource = source;
	}

	setToolSource(source: ToolRuntimeSource | undefined): void {
		this.#toolSource = source;
	}

	setHeight(height: number): void {
		this.#height = Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	toggleExpanded(): boolean {
		this.#expanded = !this.#expanded;
		return this.#expanded;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		if (!this.#extension) {
			return [theme.fg("muted", "Select an extension"), theme.fg("dim", "to view details")];
		}
		this.#width = width;
		this.#toolFrame = snapshotToolRuntimeSource(this.#toolSource);
		return this.#renderExtension(this.#extension, width);
	}

	#renderExtension(ext: Extension, width: number): string[] {
		const lines: string[] = [];
		const kind = this.#kindView(ext);

		this.#pushIdentity(lines, ext, kind.title);
		this.#pushRuntime(lines, ext, kind);
		this.#pushDescription(lines, kind.description, width);
		this.#pushGuidance(lines, kind.guidance, width);
		this.#pushOrigin(lines, ext, width);
		if (kind.surface.length > 0) lines.push(...kind.surface);
		if (kind.contents.length > 0) lines.push(...kind.contents);
		if (kind.preview) {
			const reserved = kind.config.length + 1;
			// +2 preserves the heading/rule budget the section composes around the body.
			const remaining =
				this.#height > 0 ? Math.max(4, this.#height - (lines.length + 2) - reserved) : PREVIEW_LINE_BUDGET;
			const previewBody: string[] = [];
			this.#pushPreview(previewBody, kind.preview.text, width, remaining);
			lines.push(...this.#section(kind.preview.heading, previewBody, width));
		}
		if (kind.config.length > 0) lines.push(...kind.config);
		return lines;
	}

	#kindView(ext: Extension): KindView {
		switch (ext.kind) {
			case "mcp":
				return this.#mcpKind(ext);
			case "tool":
				return this.#toolKind(ext);
			case "rule":
				return this.#ruleKind(ext);
			case "skill":
				return this.#skillKind(ext);
			case "slash-command":
				return this.#commandKind(ext);
			case "hook":
				return this.#hookKind(ext);
			case "prompt":
				return this.#promptKind(ext);
			case "context-file":
				return this.#contextKind(ext);
			case "instruction":
				return this.#instructionKind(ext);
			default:
				return this.#fallbackKind(ext);
		}
	}

	#mcpKind(ext: Extension): KindView {
		const width = this.#width;
		const shadowed = isShadowedExtension(ext);
		const snap =
			isDiscoveredMcpServer(ext.raw) && !shadowed
				? snapshotMcpRuntime(ext.raw, this.#mcpSource, { enabled: ext.state !== "disabled" })
				: undefined;
		if (shadowed) {
			const config: string[] = [];
			if (isDiscoveredMcpServer(ext.raw) && ext.raw.command) {
				this.#pushLabeled(config, "Command", shortenPath(ext.raw.command, os.homedir()), width, "success");
			}
			if (config.length > 0) config.push("");
			return { description: undefined, surface: [], contents: [], config };
		}
		const health: MCPConnectionHealth = snap?.health ?? "disconnected";
		const transport = snap?.transport ?? "stdio";
		const runtimeLine = `${this.#mcpHealthGlyph(health)} ${formatMcpHealthLabel(health)}     ${theme.fg("muted", transport)}`;
		const runtimeExtra: string[] = [];
		if (snap?.implementationName) {
			const version = snap.implementationVersion ? ` ${snap.implementationVersion}` : "";
			runtimeExtra.push(theme.fg("dim", `${snap.implementationName}${version}`));
			if (snap.websiteUrl) runtimeExtra.push(theme.fg("dim", snap.websiteUrl));
		}
		const surface: string[] = [];
		const contents: string[] = [];
		const config: string[] = [];

		if (snap && snap.tools.length > 0) {
			const toolsBody: string[] = [];
			const { shown, hidden } = visibleMcpTools(snap.tools, this.#expanded ? snap.tools.length : MCP_TOOL_BUDGET);
			let collapsedArgs = false;
			for (const tool of shown) {
				toolsBody.push(`  ${theme.fg("accent", tool.name)}`);
				if (tool.title && tool.title !== tool.name) {
					toolsBody.push(`    ${theme.fg("muted", tool.title)}`);
				}
				if (tool.description) this.#pushWrapped(toolsBody, tool.description, width, "    ");
				const params = toolParamsFromSchema(tool.parameters);
				const inline = this.#expanded || params.length <= MCP_INLINE_ARG_LIMIT;
				if (inline) {
					this.#pushParams(toolsBody, params, width, "    ");
				} else if (params.length > 0) {
					collapsedArgs = true;
					toolsBody.push(`    ${theme.fg("dim", `${params.length} args`)}`);
				}
				toolsBody.push("");
			}
			if (hidden > 0) {
				toolsBody.push(theme.fg("dim", `  … ${hidden} more (${expandKeyHint()} to expand)`));
				toolsBody.push("");
			} else if (collapsedArgs) {
				toolsBody.push(theme.fg("dim", `  … args (${expandKeyHint()} to expand)`));
				toolsBody.push("");
			}
			contents.push(...this.#section("Tools", toolsBody, width));
		}

		if (snap && snap.resources.length > 0) {
			const resourcesBody: string[] = [];
			const { shown, hidden } = visibleMcpTools(
				snap.resources,
				this.#expanded ? snap.resources.length : MCP_TOOL_BUDGET,
			);
			for (const resource of shown) {
				resourcesBody.push(`  ${theme.fg("accent", resource.name)}`);
			}
			if (hidden > 0) {
				resourcesBody.push(theme.fg("dim", `  … ${hidden} more (${expandKeyHint()} to expand)`));
			}
			resourcesBody.push("");
			contents.push(...this.#section("Resources", resourcesBody, width));
		}

		if (snap && snap.prompts.length > 0) {
			const promptsBody: string[] = [];
			const { shown, hidden } = visibleMcpTools(
				snap.prompts,
				this.#expanded ? snap.prompts.length : MCP_TOOL_BUDGET,
			);
			for (const prompt of shown) {
				promptsBody.push(`  ${theme.fg("accent", prompt.name)}`);
			}
			if (hidden > 0) {
				promptsBody.push(theme.fg("dim", `  … ${hidden} more (${expandKeyHint()} to expand)`));
			}
			promptsBody.push("");
			contents.push(...this.#section("Prompts", promptsBody, width));
		}

		if (snap?.command)
			this.#pushLabeled(config, "Command", shortenPath(snap.command, os.homedir()), width, "success");
		if (snap?.url) this.#pushLabeled(config, "URL", snap.url, width, "success");
		if (snap?.args && snap.args.length > 0) this.#pushLabeled(config, "Args", snap.args.join(" "), width, "dim");
		if (snap && snap.envCount > 0) {
			this.#pushLabeled(config, "Env vars", `${snap.envCount} defined`, width, "dim");
		}
		if (config.length > 0) config.push("");

		return {
			title: snap?.title,
			description: snap?.description,
			guidance: snap?.instructions,
			runtimeLine,
			runtimeExtra,
			surface,
			contents,
			config,
		};
	}

	#toolKind(ext: Extension): KindView {
		const width = this.#width;
		const lives = liveToolsForExtension(ext, this.#toolFrame);
		const data = toolInspectorData(ext, lives, this.#source);
		const surface: string[] = [];
		if (data.factory.length > 1) {
			const factoryBody: string[] = [];
			let collapsedArgs = false;
			for (const tool of data.factory) {
				factoryBody.push(`  ${theme.fg("accent", tool.name)}`);
				if (tool.label && tool.label !== tool.name) {
					factoryBody.push(`    ${theme.fg("muted", tool.label)}`);
				}
				if (tool.description) this.#pushWrapped(factoryBody, tool.description, width, "    ");
				const params = toolParamsFromSchema(tool.parameters);
				const inline = this.#expanded || params.length <= MCP_INLINE_ARG_LIMIT;
				if (inline) {
					this.#pushParams(factoryBody, params, width, "    ");
				} else if (params.length > 0) {
					collapsedArgs = true;
					factoryBody.push(`    ${theme.fg("dim", `${params.length} args`)}`);
				}
				factoryBody.push("");
			}
			if (collapsedArgs) {
				factoryBody.push(theme.fg("dim", `  … args (${expandKeyHint()} to expand)`));
				factoryBody.push("");
			}
			surface.push(...this.#section("Tools", factoryBody, width));
			return { description: data.description, surface, contents: [], config: [] };
		}
		if (lives.length === 0 && data.params.length === 0) {
			return { description: data.description, surface: [], contents: [], config: [] };
		}
		const argsBody: string[] = [];
		this.#pushParams(argsBody, data.params, width, "  ");
		surface.push(...this.#section("Arguments", argsBody, width));
		return {
			title: data.label,
			description: data.description,
			surface,
			contents: [],
			config: [],
		};
	}

	#ruleKind(ext: Extension): KindView {
		const width = this.#width;
		const data = ruleInspectorData(ext, this.#source);
		const surface: string[] = [];
		const appliesBody: string[] = [];
		if (data.alwaysApply) appliesBody.push(`  ${theme.fg("accent", "always")}`);
		if (data.globs) this.#pushLabeled(appliesBody, "globs", data.globs.join(", "), width);
		if (data.condition) this.#pushLabeledList(appliesBody, "condition", data.condition, width);
		if (data.astCondition) this.#pushLabeledList(appliesBody, "ast", data.astCondition, width);
		if (data.scope) this.#pushLabeledList(appliesBody, "scope", data.scope, width);
		if (data.agents) this.#pushLabeledList(appliesBody, "agents", data.agents, width);
		if (data.interruptMode) this.#pushLabeled(appliesBody, "interrupt", data.interruptMode, width, "dim");
		if (!data.alwaysApply && !data.globs && !data.condition && !data.astCondition && !data.agents) {
			appliesBody.push(theme.fg("dim", "  (no apply conditions)"));
		}
		appliesBody.push("");
		surface.push(...this.#section("Applies", appliesBody, width));
		return {
			description: data.description,
			surface,
			contents: [],
			preview: { heading: "Rule", text: data.content },
			config: [],
		};
	}

	#skillKind(ext: Extension): KindView {
		const width = this.#width;
		const data = skillInspectorData(ext);
		const runtimeExtra: string[] = [];
		if (data.hidden) {
			this.#pushWrapped(
				runtimeExtra,
				`${theme.fg("warning", "hidden")}    omitted from the system-prompt skill list`,
				width,
				"  ",
			);
			runtimeExtra.push(this.#rule());
		}
		const surface: string[] = [];
		if (data.alwaysApply) surface.push(`  ${theme.fg("accent", "always apply")}`);
		if (data.globs) this.#pushLabeled(surface, "globs", data.globs.join(", "), width);
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

	#commandKind(ext: Extension): KindView {
		const data = commandInspectorData(ext);
		const surface: string[] = [];
		const invocationBody: string[] = [];
		invocationBody.push(`  ${theme.fg("accent", `/${sanitizeDisplayText(ext.name)}`)}`);
		if (data.argumentHint) this.#pushLabeled(invocationBody, "hint", data.argumentHint, this.#width, "dim");
		if (data.usesArguments) invocationBody.push(`  ${theme.fg("dim", "accepts $ARGUMENTS")}`);
		invocationBody.push("");
		surface.push(...this.#section("Invocation", invocationBody, this.#width));
		return {
			description: data.description,
			surface,
			contents: [],
			preview: { heading: "Template", text: data.body },
			config: [],
		};
	}

	#hookKind(ext: Extension): KindView {
		const data = hookInspectorData(ext);
		const surface: string[] = [];
		const hookBody: string[] = [];
		if (data.hookType) this.#pushLabeled(hookBody, "when", data.hookType, this.#width);
		if (data.tool) this.#pushLabeled(hookBody, "tool", data.tool, this.#width);
		hookBody.push("");
		surface.push(...this.#section("Hook", hookBody, this.#width));
		return { description: ext.description, surface, contents: [], config: [] };
	}

	#promptKind(ext: Extension): KindView {
		const data = promptInspectorData(ext);
		return {
			description: ext.description,
			surface: [],
			contents: [],
			preview: { heading: "Prompt", text: data.content },
			config: [],
		};
	}

	#contextKind(ext: Extension): KindView {
		const data = contextInspectorData(ext);
		return {
			description: ext.description,
			surface: [],
			contents: [],
			preview: { heading: "Preview", text: data.content },
			config: [],
		};
	}

	#instructionKind(ext: Extension): KindView {
		const data = instructionInspectorData(ext);
		const surface: string[] = [];
		if (data.applyTo) {
			const filesBody: string[] = [];
			this.#pushLabeled(filesBody, "files", data.applyTo, this.#width);
			filesBody.push("");
			surface.push(...this.#section("Applies", filesBody, this.#width));
		}
		return {
			description: ext.description,
			surface,
			contents: [],
			preview: { heading: "Instruction", text: data.content },
			config: [],
		};
	}

	#fallbackKind(ext: Extension): KindView {
		const surface: string[] = [];
		if (ext.trigger) {
			const triggerBody: string[] = [`  ${theme.fg("accent", ext.trigger)}`, ""];
			surface.push(...this.#section("Trigger", triggerBody, this.#width));
		}
		return { description: ext.description, surface, contents: [], config: [] };
	}

	#pushIdentity(lines: string[], ext: Extension, title: string | undefined): void {
		const name = sanitizeDisplayLine(ext.displayName);
		lines.push(theme.bold(theme.fg("accent", name)));
		const cleanTitle = sanitizeDisplayLineField(title);
		if (cleanTitle && cleanTitle !== name) lines.push(theme.fg("muted", cleanTitle));
		lines.push("");
	}
	#pushRuntime(lines: string[], ext: Extension, kind: KindView): void {
		if (kind.runtimeLine) {
			lines.push(kind.runtimeLine);
			if (kind.runtimeExtra) lines.push(...kind.runtimeExtra);
			if (ext.state !== "active") {
				lines.push(`  ${this.#getStatusBadge(ext.state, ext.disabledReason, ext.shadowedBy)}`);
			}
			lines.push("");
			return;
		}
		lines.push(this.#getStatusBadge(ext.state, ext.disabledReason, ext.shadowedBy));
		if (kind.runtimeExtra) lines.push(...kind.runtimeExtra);
		lines.push("");
	}

	#pushDescription(lines: string[], description: string | undefined, width: number): void {
		this.#pushShortText(lines, description, width);
	}

	#pushGuidance(lines: string[], guidance: string | undefined, width: number): void {
		this.#pushShortText(lines, guidance, width);
	}

	#pushShortText(lines: string[], value: string | undefined, width: number): void {
		const text = sanitizeDisplayField(value);
		if (!text) return;
		const wrapped: string[] = [];
		for (const raw of sanitizeDisplayText(text).split("\n")) {
			const folded = wrapTextWithAnsi(replaceTabs(raw), Math.max(8, width));
			if (folded.length === 0) wrapped.push("");
			else wrapped.push(...folded);
		}
		if (this.#expanded || wrapped.length <= MCP_INLINE_DESC_LINES) {
			lines.push(...wrapped);
		} else {
			lines.push(...wrapped.slice(0, MCP_INLINE_DESC_LINES));
			lines.push(
				theme.fg("dim", `  … ${wrapped.length - MCP_INLINE_DESC_LINES} more (${expandKeyHint()} to expand)`),
			);
		}
		lines.push("");
	}

	#pushOrigin(lines: string[], ext: Extension, width: number): void {
		lines.push(theme.fg("muted", "Origin:"));
		const levelLabel = ext.source.level === "user" ? "User" : ext.source.level === "project" ? "Project" : "Native";
		this.#pushWrapped(
			lines,
			theme.italic(`via ${sanitizeDisplayText(ext.source.providerName)} (${levelLabel})`),
			width,
			"  ",
		);
		this.#pushWrapped(lines, theme.fg("dim", sanitizeDisplayText(shortenPath(ext.path, os.homedir()))), width, "  ");
		lines.push("");
	}

	#pushLabeled(
		lines: string[],
		label: string,
		value: string,
		width: number,
		valueColor: "accent" | "dim" | "success" = "accent",
	): void {
		const list = new KeyValueList(
			[{ label, value: sanitizeDisplayText(value), valueStyle: text => theme.fg(valueColor, text) }],
			{ indent: "  ", labelWidth: 10, gap: " ", minValueWidth: 8, labelOverflow: "allow" },
		);
		lines.push(...list.render(width));
	}

	#pushLabeledList(lines: string[], label: string, items: string[], width: number): void {
		if (items.length === 1) {
			this.#pushLabeled(lines, label, items[0], width);
			return;
		}
		const cap = this.#expanded ? items.length : PREVIEW_LIMITS.COLLAPSED_LINES;
		const shown = items.slice(0, cap);
		const hidden = items.length - shown.length;
		const indent = "             ";
		if (hidden > 0) {
			this.#pushLabeled(lines, label, `${items.length} patterns`, width, "dim");
			for (const item of shown) this.#pushWrapped(lines, item, width, indent);
			lines.push(theme.fg("dim", `${indent}… ${hidden} more (${expandKeyHint()} to expand)`));
			return;
		}
		this.#pushLabeled(lines, label, shown[0] ?? "", width);
		for (const item of shown.slice(1)) this.#pushWrapped(lines, item, width, indent);
	}

	#pushParams(lines: string[], params: ToolParamView[], width: number, indent: string): void {
		if (params.length === 0) {
			lines.push(`${indent}${theme.fg("dim", "(no arguments)")}`);
			return;
		}
		for (const param of params) {
			const required = param.required;
			lines.push(
				renderTableRow(
					[
						{ text: param.name },
						{ text: param.type },
						{ text: param.flag, style: flag => theme.fg(required ? "warning" : "dim", flag) },
					],
					[
						{ width: 12, align: "left", overflow: "allow", style: name => theme.fg("accent", name) },
						{ width: 10, align: "left", overflow: "allow", style: type => theme.fg("muted", type) },
						{ width: visibleWidth(param.flag), align: "left", overflow: "allow" },
					],
					undefined,
					{ gap: " ", indent, fit: false },
				),
			);
			if (param.description) this.#pushWrapped(lines, param.description, width, `${indent}  `);
		}
	}

	#pushPreview(lines: string[], text: string, width: number, budget: number): void {
		if (!text) {
			lines.push(theme.fg("dim", "  (empty)"));
			return;
		}
		const wrapped: string[] = [];
		for (const raw of sanitizeDisplayText(text).split("\n")) {
			const highlighted = this.#highlightMarkdown(raw);
			const folded = wrapTextWithAnsi(highlighted, Math.max(8, width - 1));
			if (folded.length === 0) wrapped.push("");
			else wrapped.push(...folded);
		}
		if (this.#expanded || wrapped.length <= budget) {
			lines.push(...wrapped);
			return;
		}
		const shownBudget = Math.max(1, budget - 1);
		lines.push(...wrapped.slice(0, shownBudget));
		lines.push(theme.fg("dim", `  … ${wrapped.length - shownBudget} more (${expandKeyHint()} to expand)`));
	}

	#highlightMarkdown(line: string): string {
		if (/^#{1,6}\s/.test(line)) return theme.bold(theme.fg("accent", line));
		if (line.startsWith("```")) return theme.fg("dim", line);
		if (/^[\s]*[-*+]\s/.test(line)) return line.replace(/^([\s]*[-*+]\s)/, theme.fg("accent", "$1"));
		if (/^[\s]*\d+\.\s/.test(line)) return line.replace(/^([\s]*\d+\.\s)/, theme.fg("accent", "$1"));
		return line;
	}

	#pushWrapped(lines: string[], text: string, width: number, indent = ""): void {
		const budget = Math.max(1, width - indent.length);
		const wrapped = wrapTextWithAnsi(replaceTabs(text), budget);
		for (const line of wrapped.length > 0 ? wrapped : [""]) {
			lines.push(`${indent}${line}`);
		}
	}

	#section(title: string, body: string[], width: number): string[] {
		// Section owns the one trailing spacer; callers retain interior blank
		// rows between repeated entries without doubling the section boundary.
		const sectionBody = body.at(-1) === "" ? body.slice(0, -1) : body;
		return [
			...new Section({
				title,
				body: sectionBody,
				titleStyle: heading => theme.fg("muted", heading),
				ruleStyle: rule => theme.fg("dim", rule),
				ruleGlyph: "─",
				ruleWidth: 40,
				blankAfter: true,
			}).render(width),
		];
	}

	#rule(): string {
		return theme.fg("dim", "────────────────────────────────────────");
	}

	#mcpHealthGlyph(health: MCPConnectionHealth): string {
		switch (health) {
			case "connected":
				return theme.fg("success", theme.status.enabled);
			case "connecting":
				return theme.fg("muted", theme.status.running);
			case "disconnected":
				return theme.fg("dim", theme.status.shadowed);
			case "inactive":
				return theme.fg("warning", theme.status.disabled);
		}
	}

	#getStatusBadge(state: ExtensionState, reason?: string, shadowedBy?: string): string {
		switch (state) {
			case "active":
				return theme.fg("success", `${theme.status.enabled} ${enablementLabel(state)}`);
			case "disabled":
				return theme.fg("dim", `${theme.status.disabled} ${enablementLabel(state, reason)}`);
			case "shadowed":
				return theme.fg("warning", `${theme.status.shadowed} ${enablementLabel(state, reason, shadowedBy)}`);
		}
	}
}

function inspectorExtensionKey(extension: Extension | null): string | null {
	if (!extension) return null;
	return `${extension.kind}:${extension.id}:${extension.path}`;
}
