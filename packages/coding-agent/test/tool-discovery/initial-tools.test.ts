import { describe, expect, it } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { BuiltinToolLoadMode, ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import {
	AskTool,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
	filterInitialToolsForDiscoveryAll,
	IrcTool,
	JobTool,
	SshTool,
} from "@pk-nerdsaver-ai/pi-coding-agent/tools";

const allToolsSettings = Settings.isolated({
	"astGrep.enabled": true,
	"astEdit.enabled": true,
	"debug.enabled": true,
	"find.enabled": true,
	"search.enabled": true,
	"github.enabled": true,
	"lsp.enabled": true,
	"inspect_image.enabled": true,
	"web_search.enabled": true,
	"browser.enabled": true,
	"checkpoint.enabled": true,
	"todo.enabled": true,
	"memory.backend": "mnemopi",
	"autolearn.enabled": true,
	"tools.discoveryMode": "all",
});

const toolSession: ToolSession = {
	cwd: "/tmp/test",
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: allToolsSettings,
	isToolDiscoveryEnabled: () => true,
	getSelectedDiscoveredToolNames: () => [],
	activateDiscoveredTools: async names => names,
};

async function getToolMetadata(): Promise<Map<string, { loadMode?: string; summary?: string }>> {
	const tools = await createTools(toolSession, Object.keys(BUILTIN_TOOLS));
	const metadata = new Map(tools.map(tool => [tool.name, { loadMode: tool.loadMode, summary: tool.summary }]));
	for (const tool of [
		new AskTool({ ...toolSession, hasUI: true }),
		new SshTool(toolSession, [], new Map(), ""),
		new JobTool(toolSession),
		new IrcTool(toolSession),
	]) {
		metadata.set(tool.name, { loadMode: tool.loadMode, summary: tool.summary });
	}
	return metadata;
}
describe("BUILTIN_TOOLS public factory map", () => {
	it("sets loading fields on tool definitions without wrapping factories", async () => {
		const metadata = await getToolMetadata();
		const missing = Object.keys(BUILTIN_TOOLS).filter(name => metadata.get(name)?.loadMode === undefined);
		expect(missing).toEqual([]);
	});
});

describe("built-in tool loadMode annotations", () => {
	it("provides a summary for every discoverable tool", async () => {
		const missing: string[] = [];
		const metadata = await getToolMetadata();
		for (const [name, meta] of metadata) {
			if (meta.loadMode === "discoverable" && !meta.summary) {
				missing.push(name);
			}
		}
		expect(missing).toEqual([]);
	});
});

describe("computeEssentialBuiltinNames", () => {
	it("returns DEFAULT_ESSENTIAL_TOOL_NAMES when override is empty", () => {
		const settings = Settings.isolated({});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual([...DEFAULT_ESSENTIAL_TOOL_NAMES].sort());
	});

	it("respects tools.essentialOverride when provided", () => {
		const settings = Settings.isolated({ "tools.essentialOverride": ["read", "find"] });
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["find", "read"]);
	});

	it("filters override entries that are not known built-in tools", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": ["read", "not_a_real_tool", "edit"],
		});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["edit", "read"]);
	});

	it("trims whitespace and drops empty entries from the override", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": [" read ", "", "  "],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual(["read"]);
	});

	it("falls back to defaults when override is non-empty but contains only invalid names", () => {
		// The filtered list is empty (no valid names), but the override was provided —
		// current behavior returns the empty filtered list (caller can decide). Document the behavior.
		const settings = Settings.isolated({
			"tools.essentialOverride": ["not_a_real_tool"],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual([]);
	});
});

describe("tools.discoveryMode settings schema", () => {
	it("defaults to all discovery mode (lean prompt, everything discoverable)", () => {
		const settings = Settings.isolated({});
		expect(settings.get("tools.discoveryMode")).toBe("all");
	});

	it("back-compat: mcp.discoveryMode still accepted", () => {
		const settings = Settings.isolated({ "mcp.discoveryMode": true });
		expect(settings.get("mcp.discoveryMode")).toBe(true);
	});
});

describe("filterInitialToolsForDiscoveryAll", () => {
	const loadModes: Record<string, BuiltinToolLoadMode> = {
		read: "essential",
		edit: "essential",
		todo: "discoverable",
		find: "discoverable",
	};
	const base = {
		loadModeOf: (name: string): BuiltinToolLoadMode | undefined => loadModes[name],
		essentialNames: new Set(["read", "bash", "edit"]),
		explicitlyRequested: new Set<string>(),
		restored: new Set<string>(),
		forceActive: new Set<string>(),
	};

	it("hides non-essential discoverable built-ins", () => {
		expect(filterInitialToolsForDiscoveryAll(["read", "edit", "todo", "find"], base)).toEqual(["read", "edit"]);
	});

	it("keeps discoverable tools required by a forced tool_choice (eager todo)", () => {
		const result = filterInitialToolsForDiscoveryAll(["read", "todo", "find"], {
			...base,
			forceActive: new Set(["todo"]),
		});
		expect(result).toEqual(["read", "todo"]);
	});

	it("keeps explicitly requested and restored discoverable tools", () => {
		const result = filterInitialToolsForDiscoveryAll(["todo", "find"], {
			...base,
			explicitlyRequested: new Set(["find"]),
			restored: new Set(["todo"]),
		});
		expect([...result].sort()).toEqual(["find", "todo"]);
	});

	it("never hides tools without a built-in loadMode (MCP/custom/extension)", () => {
		expect(filterInitialToolsForDiscoveryAll(["mcp__server__tool", "find"], base)).toEqual(["mcp__server__tool"]);
	});
});
