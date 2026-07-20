import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { toolWireSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { BUILTIN_TOOL_NAMES } from "./builtin-names";
import { CONTROL_BUILTIN_NAMES, type ToolSource } from "./tool-profiles";

const XDEV_TOTAL_DOCS_BUDGET = 48_000;
const XDEV_DEVICE_DOCS_CAP = 10_000;
const XDEV_EXTERNAL_DESCRIPTION_CAP = 200;

const XDEV_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set([
	...BUILTIN_TOOL_NAMES,
	...CONTROL_BUILTIN_NAMES,
	// Legacy aliases and hidden tools are not all present in BUILTIN_TOOL_NAMES.
	"find",
	"search",
	"goal",
	"report_finding",
]);

export interface XdevRegistryOptions {
	enabled: boolean;
	sourceOf?: (name: string) => ToolSource | undefined;
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function firstDescriptionLine(tool: AgentTool): string {
	const source = tool.summary?.trim() || tool.description?.trim() || "(no description)";
	return truncate(source.split(/\r?\n/, 1)[0] ?? "(no description)", XDEV_EXTERNAL_DESCRIPTION_CAP);
}

/** Session-owned registry of tools exposed through the opt-in xd:// surface. */
export class XdevRegistry {
	readonly #enabled: boolean;
	readonly #sourceOf: ((name: string) => ToolSource | undefined) | undefined;
	#tools = new Map<string, AgentTool>();

	constructor(options: XdevRegistryOptions) {
		this.#enabled = options.enabled;
		this.#sourceOf = options.sourceOf;
	}

	isMountable(tool: AgentTool): boolean {
		if (!this.#enabled || XDEV_BLOCKED_TOOL_NAMES.has(tool.name.toLowerCase())) return false;
		const source = this.#sourceOf?.(tool.name) ?? (tool.name.startsWith("mcp__") ? "mcp" : undefined);
		return source === "mcp" || source === "custom" || source === "extension";
	}

	reconcile(tools: Iterable<AgentTool>): void {
		const next = new Map<string, AgentTool>();
		for (const tool of tools) {
			if (this.isMountable(tool)) next.set(tool.name, tool);
		}
		this.#tools = next;
	}

	list(): AgentTool[] {
		return [...this.#tools.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	get(name: string): AgentTool | undefined {
		return this.#tools.get(name);
	}

	listing(): string {
		const tools = this.list();
		if (tools.length === 0) return "No MCP, custom, or extension tools are mounted under xd://.";

		const lines = [
			"# Virtual tool devices",
			"",
			"Read `xd://<tool>` for its schema; write a JSON object to the same URL to execute it.",
			"",
		];
		for (const tool of tools) {
			const line = `- \`xd://${tool.name}\` — ${firstDescriptionLine(tool)}`;
			if (lines.join("\n").length + line.length + 1 > XDEV_TOTAL_DOCS_BUDGET) {
				lines.push("- … additional devices omitted (listing budget reached)");
				break;
			}
			lines.push(line);
		}
		return lines.join("\n");
	}

	docs(name: string): string | undefined {
		const tool = this.get(name);
		if (!tool) return undefined;
		const schema = JSON.stringify(toolWireSchema(tool), null, 2);
		return truncate(
			[
				`# xd://${tool.name}`,
				"",
				truncate(tool.description?.trim() || "(no description)", XDEV_EXTERNAL_DESCRIPTION_CAP),
				"",
				"## JSON arguments",
				"",
				"```json",
				schema,
				"```",
				"",
				`Execute with \`write xd://${tool.name}\` and a JSON object as content.`,
			].join("\n"),
			XDEV_DEVICE_DOCS_CAP,
		);
	}
}
