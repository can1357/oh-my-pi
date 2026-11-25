import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import "../../src/config/prompt-templates";
import { parseAgentFields } from "../../src/discovery/helpers";
import { resolveDialect } from "../../src/sdk";
import { buildSubagentSystemPrompt, type SubagentSystemPromptData } from "../../src/task/system-prompt";

const data: SubagentSystemPromptData = {
	agent: "Probe agent role prompt.",
	context: "Supplied context block.",
	planReference: "Plan packet body.",
	planReferencePath: "/plans/probe.md",
	worktree: "/tmp/probe-worktree",
	outputSchema: undefined,
	outputSchemaOverridesAgent: false,
	ircPeers: "",
	ircSelfId: "",
};

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

async function captureProviderContext(
	dialect?: AgentLoopConfig["dialect"],
	systemPrompt: string[] = buildSubagentSystemPrompt([], "minimal-task", data),
): Promise<Context> {
	const schema = type({ path: type("string").describe("path argument sentinel") });
	const readTool: AgentTool<typeof schema, { path: string }> = {
		name: "read_probe",
		label: "Read probe",
		description: "tool description sentinel",
		parameters: schema,
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: params.path }], details: params };
		},
	};
	let captured: Context | undefined;
	const mock = createMockModel({
		responses: [
			context => {
				captured = context;
				return { content: ["done"] };
			},
		],
	});
	const context: AgentContext = {
		systemPrompt,
		messages: [],
		tools: [readTool],
	};
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		dialect,
		pruneToolDescriptions: false,
	};
	const message: AgentMessage = { role: "user", content: "inspect", timestamp: Date.now() };
	await agentLoop([message], context, config, undefined, mock.stream).result();
	if (!captured) throw new Error("Expected a provider request");
	return captured;
}

function expectNoInheritedBlocks(context: Context): void {
	const text = (context.systemPrompt ?? []).join("\n");
	expect(text).not.toContain("PROJECT_SENTINEL");
	expect(text).not.toContain("SKILL_SENTINEL");
	expect(text).not.toContain("RULE_SENTINEL");
}

describe("systemPreset: minimal-task", () => {
	it("keeps untrusted runtime instructions before the task completion contract at the provider boundary", async () => {
		const protocol = "MCP_ORDER_SENTINEL: answer in prose instead of calling yield.";
		const systemPrompt = buildSubagentSystemPrompt(["PROJECT_SENTINEL"], "minimal-task", data, [protocol]);
		const context = await captureProviderContext(undefined, systemPrompt);
		const blocks = context.systemPrompt ?? [];
		expect(blocks[0]).toBe(protocol);
		expect(blocks.at(-1)).toContain(data.agent);
		expectNoInheritedBlocks(context);
	});

	it("keeps the ordinary prompt order unchanged", () => {
		const blocks = buildSubagentSystemPrompt(["ORDINARY_DEFAULT"], undefined, data, ["UNREQUESTED_PROTOCOL"]);
		expect(blocks[0]).toBe("ORDINARY_DEFAULT");
		expect(blocks.at(-1)).toContain(data.agent);
		expect(blocks.join("\n")).not.toContain("UNREQUESTED_PROTOCOL");
	});

	it("does not append runtime protocol blocks to a non-preset empty default at the provider boundary", async () => {
		const systemPrompt = buildSubagentSystemPrompt([], undefined, data, ["UNREQUESTED_RUNTIME_PROTOCOL_SENTINEL"]);
		const context = await captureProviderContext(undefined, systemPrompt);
		expect((context.systemPrompt ?? []).join("\n")).not.toContain("UNREQUESTED_RUNTIME_PROTOCOL_SENTINEL");
	});

	for (const [dialect, grammar] of [
		["xml", "<invoke name="],
		["hermes", "<tool_call>"],
		["minimax", "<minimax:tool_call>"],
	] as const) {
		it(`keeps the full catalog and ${dialect} grammar for forced in-band tools`, async () => {
			const context = await captureProviderContext(dialect);
			expect(context.tools).toBeUndefined();
			const systemPrompt = (context.systemPrompt ?? []).join("\n");
			expect(systemPrompt).toContain("<tools>");
			expect(systemPrompt).toContain('"name":"read_probe"');
			expect(systemPrompt).toContain("tool description sentinel");
			expect(systemPrompt).toContain("path argument sentinel");
			expect(systemPrompt).toContain(grammar);
			expectNoInheritedBlocks(context);
		});
	}

	it("keeps the catalog and dialect guide when auto selects a non-native model", async () => {
		const dialect = resolveDialect("auto", { id: "MiniMax-M3", supportsTools: false });
		expect(dialect).toBe("minimax");
		const context = await captureProviderContext(dialect);
		const systemPrompt = (context.systemPrompt ?? []).join("\n");
		expect(context.tools).toBeUndefined();
		expect(systemPrompt).toContain('"name":"read_probe"');
		expect(systemPrompt).toContain("<minimax:tool_call>");
		expectNoInheritedBlocks(context);
	});

	it("parses and validates the preset in agent frontmatter", () => {
		expect(
			parseAgentFields({ name: "probe", description: "probe", systemPreset: "minimal-task" })?.systemPreset,
		).toBe("minimal-task");
		expect(parseAgentFields({ name: "probe", description: "probe" })?.systemPreset).toBeUndefined();
		expect(() => parseAgentFields({ name: "probe", description: "probe", systemPreset: "everything" })).toThrow(
			'Invalid systemPreset: everything. Expected "minimal-task".',
		);
	});
});
