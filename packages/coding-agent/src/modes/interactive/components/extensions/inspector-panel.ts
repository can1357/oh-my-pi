/**
 * InspectorPanel - Detail view for selected extension.
 *
 * Shows name, description, origin, status, and kind-specific preview.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { theme } from "../../theme/theme";
import type { Extension, ExtensionState } from "./types";

export class InspectorPanel implements Component {
	private extension: Extension | null = null;

	setExtension(extension: Extension | null): void {
		this.extension = extension;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.extension) {
			return [theme.fg("muted", "Select an extension"), theme.fg("dim", "to view details")];
		}

		const ext = this.extension;
		const lines: string[] = [];

		// Name header
		lines.push(theme.bold(theme.fg("accent", ext.displayName)));
		lines.push("");

		// Kind badge
		lines.push(theme.fg("muted", "Type: ") + this.getKindBadge(ext.kind));
		lines.push("");

		// Description (wrapped)
		if (ext.description) {
			const wrapped = wrapTextWithAnsi(ext.description, width - 2);
			for (const line of wrapped) {
				lines.push(truncateToWidth(line, width));
			}
			lines.push("");
		}

		// Origin
		lines.push(theme.fg("muted", "Origin:"));
		const levelLabel = ext.source.level === "user" ? "User" : ext.source.level === "project" ? "Project" : "Native";
		lines.push(`  ${theme.italic(`via ${ext.source.providerName} (${levelLabel})`)}`);
		lines.push(`  ${theme.fg("dim", this.shortenPath(ext.path))}`);
		lines.push("");

		// Status badge
		lines.push(theme.fg("muted", "Status:"));
		lines.push(`  ${this.getStatusBadge(ext.state, ext.disabledReason, ext.shadowedBy)}`);
		lines.push("");

		// Preview section (routed based on kind)
		const previewLines = this.renderPreview(ext, width);
		lines.push(...previewLines);

		return lines;
	}

	private renderPreview(ext: Extension, width: number): string[] {
		const lines: string[] = [];
		let content: string[] = [];

		switch (ext.kind) {
			case "context-file":
				content = this.renderFilePreview(ext.path, width);
				break;
			case "tool":
				content = this.renderToolArgs(ext.raw, width);
				break;
			case "skill":
				content = this.renderSkillContent(ext.raw, width);
				break;
			case "mcp":
				content = this.renderMcpDetails(ext.raw, width);
				break;
			default:
				content = this.renderDefaultPreview(ext, width);
				break;
		}

		if (content.length > 0) {
			lines.push(...content);
		}

		return lines;
	}

	private renderFilePreview(path: string, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "Preview:"));
		lines.push(theme.fg("dim", "─".repeat(Math.min(width - 2, 40))));

		try {
			const content = readFileSync(path, "utf-8");
			const fileLines = content.split("\n").slice(0, 20);

			for (const line of fileLines) {
				const highlighted = this.highlightMarkdown(line);
				lines.push(truncateToWidth(highlighted, width - 2));
			}

			if (content.split("\n").length > 20) {
				lines.push(theme.fg("dim", "(truncated at line 20)"));
			}
		} catch (err) {
			lines.push(theme.fg("error", `Failed to read file: ${err instanceof Error ? err.message : String(err)}`));
		}

		lines.push("");
		return lines;
	}

	private highlightMarkdown(line: string): string {
		// Basic markdown syntax highlighting
		let highlighted = line;

		// Headers
		if (/^#{1,6}\s/.test(highlighted)) {
			highlighted = theme.bold(theme.fg("accent", highlighted));
		}
		// Code blocks
		else if (/^```/.test(highlighted)) {
			highlighted = theme.fg("dim", highlighted);
		}
		// Lists
		else if (/^[\s]*[-*+]\s/.test(highlighted)) {
			highlighted = highlighted.replace(/^([\s]*[-*+]\s)/, theme.fg("accent", "$1"));
		}
		// Numbered lists
		else if (/^[\s]*\d+\.\s/.test(highlighted)) {
			highlighted = highlighted.replace(/^([\s]*\d+\.\s)/, theme.fg("accent", "$1"));
		}

		return highlighted;
	}

	private renderToolArgs(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "Arguments:"));
		lines.push(theme.fg("dim", "─".repeat(Math.min(width - 2, 40))));

		try {
			const tool = raw as any;
			const params = tool?.parameters?.properties || tool?.inputSchema?.properties || {};

			if (Object.keys(params).length === 0) {
				lines.push(theme.fg("dim", "  (no arguments)"));
			} else {
				const required = new Set(tool?.parameters?.required || tool?.inputSchema?.required || []);

				for (const [name, spec] of Object.entries(params)) {
					const param = spec as any;
					const type = param.type || "any";
					const isRequired = required.has(name);
					const defaultVal = param.default !== undefined ? `Default: ${param.default}` : null;

					const nameCol = theme.fg("accent", name.padEnd(12));
					const typeCol = theme.fg("muted", type.padEnd(10));
					const reqCol = isRequired
						? theme.fg("warning", "Required")
						: defaultVal
							? theme.fg("dim", defaultVal)
							: theme.fg("dim", "Optional");

					lines.push(`  ${nameCol} ${typeCol} ${reqCol}`);
				}
			}
		} catch {
			lines.push(theme.fg("dim", "  (unable to parse tool definition)"));
		}

		lines.push("");
		return lines;
	}

	private renderSkillContent(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "Instruction:"));
		lines.push(theme.fg("dim", "─".repeat(Math.min(width - 2, 40))));

		try {
			const skill = raw as any;
			const instruction = skill?.prompt || skill?.instruction || skill?.content || "";

			if (!instruction) {
				lines.push(theme.fg("dim", "  (no instruction text)"));
			} else {
				const instructionLines = instruction.split("\n").slice(0, 15);
				for (const line of instructionLines) {
					lines.push(truncateToWidth(line, width - 2));
				}

				if (instruction.split("\n").length > 15) {
					lines.push(theme.fg("dim", "(truncated at line 15)"));
				}
			}
		} catch {
			lines.push(theme.fg("dim", "  (unable to parse skill content)"));
		}

		lines.push("");
		return lines;
	}

	private renderMcpDetails(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "Connection:"));
		lines.push(theme.fg("dim", "─".repeat(Math.min(width - 2, 40))));

		try {
			const mcp = raw as any;
			const transport = mcp?.transport || mcp?.type || "unknown";
			const command = mcp?.command || mcp?.cmd || "";
			const args = mcp?.args || mcp?.arguments || [];

			lines.push(`  ${theme.fg("muted", "Transport:")}  ${theme.fg("accent", transport)}`);

			if (command) {
				lines.push(`  ${theme.fg("muted", "Command:")}    ${theme.fg("success", command)}`);
			}

			if (Array.isArray(args) && args.length > 0) {
				lines.push(`  ${theme.fg("muted", "Args:")}       ${theme.fg("dim", args.join(" "))}`);
			}

			// Environment variables if present
			if (mcp?.env && typeof mcp.env === "object") {
				const envCount = Object.keys(mcp.env).length;
				if (envCount > 0) {
					lines.push(`  ${theme.fg("muted", "Env vars:")}   ${theme.fg("dim", `${envCount} defined`)}`);
				}
			}
		} catch {
			lines.push(theme.fg("dim", "  (unable to parse MCP configuration)"));
		}

		lines.push("");
		return lines;
	}

	private renderDefaultPreview(ext: Extension, width: number): string[] {
		const lines: string[] = [];

		// Show trigger pattern if present
		if (ext.trigger) {
			lines.push(theme.fg("muted", "Trigger:"));
			lines.push(theme.fg("dim", "─".repeat(Math.min(width - 2, 40))));
			lines.push(`  ${theme.fg("accent", ext.trigger)}`);
			lines.push("");
		}

		return lines;
	}

	private getKindBadge(kind: string): string {
		const kindColors: Record<string, string> = {
			skill: "accent",
			rule: "success",
			tool: "warning",
			mcp: "accent",
			prompt: "muted",
			hook: "warning",
			"context-file": "dim",
			instruction: "muted",
			"slash-command": "accent",
		};

		const color = kindColors[kind] || "muted";
		return theme.fg(color as any, kind);
	}

	private getStatusBadge(state: ExtensionState, reason?: string, shadowedBy?: string): string {
		switch (state) {
			case "active":
				return theme.fg("success", "● Active");
			case "disabled": {
				const reasonText =
					reason === "provider-disabled"
						? "provider disabled"
						: reason === "item-disabled"
							? "manually disabled"
							: "unknown";
				return theme.fg("dim", `○ Disabled (${reasonText})`);
			}
			case "shadowed":
				return theme.fg("warning", `◐ Shadowed${shadowedBy ? ` by ${shadowedBy}` : ""}`);
		}
	}

	private shortenPath(path: string): string {
		const home = homedir();
		if (path.startsWith(home)) {
			return `~${path.slice(home.length)}`;
		}

		// If path is very long, show just the last parts
		if (path.length > 40) {
			const parts = path.split("/");
			if (parts.length > 3) {
				return `.../${parts.slice(-3).join("/")}`;
			}
		}

		return path;
	}
}
