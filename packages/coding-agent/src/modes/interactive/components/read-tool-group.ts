import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { shortenPath } from "../../../core/tools/render-utils";
import { theme } from "../theme/theme";
import type { ToolExecutionHandle } from "./tool-execution";

type ReadRenderArgs = {
	path?: string;
	file_path?: string;
	offset?: number;
	limit?: number;
};

type ReadEntry = {
	toolCallId: string;
	path: string;
	offset?: number;
	limit?: number;
	status: "pending" | "success" | "error";
};

export class ReadToolGroupComponent extends Container implements ToolExecutionHandle {
	private entries = new Map<string, ReadEntry>();
	private text: Text;

	constructor() {
		super();
		this.text = new Text("", 0, 0);
		this.addChild(this.text);
		this.updateDisplay();
	}

	updateArgs(args: ReadRenderArgs, toolCallId?: string): void {
		if (!toolCallId) return;
		const rawPath = args.file_path || args.path || "";
		const entry: ReadEntry = this.entries.get(toolCallId) ?? {
			toolCallId,
			path: rawPath,
			offset: args.offset,
			limit: args.limit,
			status: "pending",
		};
		entry.path = rawPath;
		entry.offset = args.offset;
		entry.limit = args.limit;
		this.entries.set(toolCallId, entry);
		this.updateDisplay();
	}

	updateResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		isPartial = false,
		toolCallId?: string,
	): void {
		if (!toolCallId) return;
		const entry = this.entries.get(toolCallId);
		if (!entry) return;
		if (isPartial) return;
		entry.status = result.isError ? "error" : "success";
		this.updateDisplay();
	}

	setArgsComplete(_toolCallId?: string): void {
		this.updateDisplay();
	}

	setExpanded(_expanded: boolean): void {
		this.updateDisplay();
	}

	getComponent(): Component {
		return this;
	}

	private updateDisplay(): void {
		const entries = [...this.entries.values()];

		if (entries.length === 0) {
			this.text.setText(` ${theme.format.bullet} ${theme.fg("toolTitle", theme.bold("Read"))}`);
			return;
		}

		if (entries.length === 1) {
			const entry = entries[0];
			const statusSymbol = this.formatStatus(entry.status);
			const pathDisplay = this.formatPath(entry);
			this.text.setText(
				` ${theme.format.bullet} ${theme.fg("toolTitle", theme.bold("Read"))} ${pathDisplay} ${statusSymbol}`.trimEnd(),
			);
			return;
		}

		const header = `${theme.fg("toolTitle", theme.bold("Read"))}${theme.fg("dim", ` (${entries.length})`)}`;
		const lines = [` ${theme.format.bullet} ${header}`];
		const total = entries.length;
		for (const [index, entry] of entries.entries()) {
			const connector = index === total - 1 ? theme.tree.last : theme.tree.branch;
			const statusSymbol = this.formatStatus(entry.status);
			const pathDisplay = this.formatPath(entry);
			lines.push(`   ${theme.fg("dim", connector)} ${statusSymbol} ${pathDisplay}`.trimEnd());
		}

		this.text.setText(lines.join("\n"));
	}

	private formatPath(entry: ReadEntry): string {
		const filePath = shortenPath(entry.path);
		let pathDisplay = filePath ? theme.fg("accent", filePath) : theme.fg("toolOutput", theme.format.ellipsis);
		if (entry.offset !== undefined || entry.limit !== undefined) {
			const startLine = entry.offset ?? 1;
			const endLine = entry.limit !== undefined ? startLine + entry.limit - 1 : "";
			pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
		}
		return pathDisplay;
	}

	private formatStatus(status: ReadEntry["status"]): string {
		if (status === "success") {
			return theme.fg("success", theme.status.success);
		}
		if (status === "error") {
			return theme.fg("error", theme.status.error);
		}
		return theme.fg("dim", theme.status.pending);
	}
}
