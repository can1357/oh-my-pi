/**
 * The extension inspector's state: the extension shown, whether its long
 * parts are expanded (reset when another extension is shown), the rows it
 * may fill, and the live sources it joins (MCP manager, session tools).
 */
import { signal } from "@oh-my-pi/pi-tui";
import type { MCPRuntimeSource } from "../../../extensibility/inventory/mcp-runtime";
import type { Extension } from "../../../extensibility/inventory/types";
import { type ExtensionInspectorSource, inspectorKey, type ToolRuntimeSource } from "./extensions-data";

export class ExtensionInspectorModel {
	readonly rev = signal(0);
	extension: Extension | null = null;
	expanded = false;
	/** Rows the inspector may fill (0: no budget). */
	height = 0;
	mcpSource: MCPRuntimeSource | undefined;
	toolSource: ToolRuntimeSource | undefined;
	#key: string | null = null;
	#rev = 0;

	constructor(readonly source?: ExtensionInspectorSource) {}

	touch(): void {
		this.rev.set(++this.#rev);
	}

	setExtension(extension: Extension | null): void {
		const key = inspectorKey(extension);
		if (key !== this.#key) {
			this.expanded = false;
			this.#key = key;
		}
		this.extension = extension;
		this.touch();
	}

	setMcpSource(source: MCPRuntimeSource | undefined): void {
		this.mcpSource = source;
		this.touch();
	}

	setToolSource(source: ToolRuntimeSource | undefined): void {
		this.toolSource = source;
		this.touch();
	}

	setHeight(height: number): void {
		this.height = Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
		this.touch();
	}

	toggleExpanded(): boolean {
		this.expanded = !this.expanded;
		this.touch();
		return this.expanded;
	}
}
