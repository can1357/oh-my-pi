import { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionTools, type SessionToolsHost } from "@oh-my-pi/pi-coding-agent/session/session-tools";

interface V8HeapSnapshot {
	snapshot: {
		meta: {
			node_fields: string[];
			node_types: Array<string | string[]>;
		};
	};
	nodes: number[];
	strings: string[];
}

const TOOL_COUNT = 50;
const REFRESH_COUNT = 20;

function alphabeticIndex(index: number): string {
	let result = "";
	do {
		result = String.fromCharCode(97 + (index % 26)) + result;
		index = Math.floor(index / 26) - 1;
	} while (index >= 0);
	return result;
}

const definitions: MCPToolDefinition[] = Array.from({ length: TOOL_COUNT }, (_, index) => ({
	name: `noop_${alphabeticIndex(index)}`,
	description: `No-op tool ${index}`,
	inputSchema: {
		type: "object",
		properties: { query: { type: "string" } },
		required: ["query"],
	},
}));
const agent = new Agent();
const settings = Settings.isolated();
const host: SessionToolsHost = {
	agent,
	sessionManager: SessionManager.inMemory(),
	settings,
	effectiveExtensionRoots: () => ({}) as never,
	modelRegistry: {} as never,
	extensionRunner: () => undefined,
	clientBridge: () => undefined,
	agentKind: () => "main",
	taskDepth: () => 0,
	isDisposed: () => false,
	isStreaming: () => false,
	queuedMessageCount: () => 0,
	planModeEnabled: () => false,
	model: () => undefined,
	memoryBackendSession: () => ({}) as never,
	clearInheritedProviderPromptCacheKey: () => {},
	clearMemoryPromotionSnapshot: () => {},
	captureMemoryPromotionSnapshot: () => {},
	emitNotice: () => {},
	notifyCommandMetadataChanged: () => {},
	localProtocolOptions: () => ({}),
};
const sessionTools = new SessionTools(host, {
	baseSystemPrompt: [],
	rebuildSystemPrompt: async toolNames => ({ systemPrompt: [toolNames.join(",")] }),
});
const connection = { name: "alpha" } as MCPServerConnection;

for (let refresh = 0; refresh < REFRESH_COUNT; refresh++) {
	await sessionTools.refreshMCPTools(MCPTool.fromTools(connection, definitions));
}

Bun.gc(true);
const heap = JSON.parse(Bun.generateHeapSnapshot("v8")) as V8HeapSnapshot;
const { node_fields: nodeFields, node_types: nodeTypes } = heap.snapshot.meta;
const typeOffset = nodeFields.indexOf("type");
const nameOffset = nodeFields.indexOf("name");
const typeNames = nodeTypes[typeOffset];
if (typeOffset < 0 || nameOffset < 0 || !Array.isArray(typeNames)) {
	throw new Error("Unexpected V8 heap snapshot schema");
}

let mcpTools = 0;
let adapters = 0;
for (let nodeOffset = 0; nodeOffset < heap.nodes.length; nodeOffset += nodeFields.length) {
	if (typeNames[heap.nodes[nodeOffset + typeOffset]!] !== "object") continue;
	const name = heap.strings[heap.nodes[nodeOffset + nameOffset]!];
	if (name === "MCPTool") mcpTools++;
	else if (name === "CustomToolAdapter") adapters++;
}

process.stdout.write(JSON.stringify({ toolCount: TOOL_COUNT, mcpTools, adapters }));
