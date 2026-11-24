import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	SoftToolRequirement,
} from "@oh-my-pi/pi-agent-core/types";
import type { Message, ToolChoice } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createHarmonyMitigationModel, createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const emptySchema = type({});

/**
 * Build a host that gates `resolve` as a soft requirement while a preview is
 * pending. The `resolve` tool clears it, mirroring coding-agent's pending
 * invoker. `getToolChoice` returns the soft requirement (a peek — never
 * consuming) until the preview resolves.
 */
function makeSoftResolveHarness() {
	let pendingPreview = true;
	let resolveRuns = 0;
	let peekRuns = 0;
	const reminder = createUserMessage("<system-reminder>Resolve the pending preview.</system-reminder>");

	const resolveTool: AgentTool<typeof emptySchema, Record<string, never>> = {
		name: "resolve",
		label: "Resolve",
		description: "Resolve the pending action",
		parameters: emptySchema,
		async execute() {
			resolveRuns++;
			pendingPreview = false;
			return { content: [{ type: "text", text: "resolved" }], details: {} };
		},
	};
	const peekTool: AgentTool<typeof emptySchema, Record<string, never>> = {
		name: "peek",
		label: "Peek",
		description: "A non-resolve detour tool",
		parameters: emptySchema,
		async execute() {
			peekRuns++;
			return { content: [{ type: "text", text: "peeked" }], details: {} };
		},
	};

	const getToolChoice = (): SoftToolRequirement | undefined =>
		pendingPreview ? { soft: true, id: "preview-1", toolName: "resolve", reminder: [reminder] } : undefined;

	return {
		tools: [resolveTool, peekTool],
		getToolChoice,
		reminder,
		get resolveRuns() {
			return resolveRuns;
		},
		get peekRuns() {
			return peekRuns;
		},
	};
}

describe("agentLoop soft tool requirement", () => {
	it("never forces tool_choice when the model complies with the reminder", async () => {
		const h = makeSoftResolveHarness();
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: h.tools };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "c1", name: "resolve", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolChoice: h.getToolChoice,
		};

		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		const messages = await stream.result();

		// Compliant: resolve ran, and NO turn ever carried a forced tool_choice.
		expect(h.resolveRuns).toBe(1);
		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[0]?.options?.toolChoice).toBeUndefined();
		expect(mock.calls[1]?.options?.toolChoice).toBeUndefined();
		// The reminder was injected exactly once (on the new requirement id).
		expect(messages.filter(m => m === h.reminder)).toHaveLength(1);
	});

	it("skips a detour batch and force-escalates resolve on the next turn", async () => {
		const h = makeSoftResolveHarness();
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: h.tools };
		const mock = createMockModel({
			responses: [
				// Turn 1: model ignores the reminder and calls a detour tool.
				{ content: [{ type: "toolCall", id: "p1", name: "peek", arguments: {} }] },
				// Turn 2: forced to resolve.
				{ content: [{ type: "toolCall", id: "r1", name: "resolve", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolChoice: h.getToolChoice,
		};

		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		const messages = await stream.result();

		// The detour tool was NOT executed (its batch was skipped), resolve ran once.
		expect(h.peekRuns).toBe(0);
		expect(h.resolveRuns).toBe(1);
		// Turn 1 ran with auto (no bust); turn 2 was force-escalated to resolve.
		expect(mock.calls[0]?.options?.toolChoice).toBeUndefined();
		expect(mock.calls[1]?.options?.toolChoice).toEqual({ type: "tool", name: "resolve" });
		// The skipped peek call still produced a paired tool result (API pairing).
		const peekResult = messages.find(m => m.role === "toolResult" && m.toolCallId === "p1");
		expect(peekResult).toBeDefined();
	});

	it("uses the satisfies predicate over bare name matching for compliance", async () => {
		let pendingPreview = true;
		const bashRuns: string[] = [];
		const reminder = createUserMessage(
			"<system-reminder>Run `resolve` to finalize the staged preview.</system-reminder>",
		);
		const bashSchema = type({ command: "string" });
		const bashTool: AgentTool<typeof bashSchema, Record<string, never>> = {
			name: "bash",
			label: "Bash",
			description: "Run a shell command",
			parameters: bashSchema,
			async execute(_id, args) {
				bashRuns.push(args.command);
				if (args.command.startsWith("resolve")) pendingPreview = false;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const getToolChoice = (): SoftToolRequirement | undefined =>
			pendingPreview
				? {
						soft: true,
						id: "preview-1",
						toolName: "bash",
						satisfies: toolCall => {
							const command = toolCall.arguments?.command;
							return toolCall.name === "bash" && typeof command === "string" && command.startsWith("resolve");
						},
						reminder: [reminder],
					}
				: undefined;
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [bashTool] };
		const mock = createMockModel({
			responses: [
				// Turn 1: the requirement's tool name, but a command that resolves nothing.
				{ content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo hi" } }] },
				// Turn 2: forced to bash; this command satisfies the predicate.
				{
					content: [{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "resolve 'preview ok'" } }],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolChoice,
		};

		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		const messages = await stream.result();

		// The non-satisfying bash run was skipped, not executed; only the resolving run ran.
		expect(bashRuns).toEqual(["resolve 'preview ok'"]);
		// Escalation still forces the requirement's tool name.
		expect(mock.calls[0]?.options?.toolChoice).toBeUndefined();
		expect(mock.calls[1]?.options?.toolChoice).toEqual({ type: "tool", name: "bash" });
		// The skipped bash call still produced a paired tool result (API pairing).
		const skipped = messages.find(m => m.role === "toolResult" && m.toolCallId === "b1");
		expect(skipped).toBeDefined();
	});

	it("does not yield while the requirement is unmet — escalates after a bare-text turn", async () => {
		const h = makeSoftResolveHarness();
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: h.tools };
		const mock = createMockModel({
			responses: [
				// Turn 1: model yields with text, no tool call.
				{ content: ["I'll get to it later."] },
				// Turn 2: forced to resolve.
				{ content: [{ type: "toolCall", id: "r1", name: "resolve", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolChoice: h.getToolChoice,
		};

		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		// The loop did not stop after the bare-text turn; it forced resolve.
		expect(h.resolveRuns).toBe(1);
		expect(mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(mock.calls[1]?.options?.toolChoice).toEqual({ type: "tool", name: "resolve" });
	});

	it("answers the calls of a turn it aborts, so continuing the run never executes them", async () => {
		const h = makeSoftResolveHarness();
		const mock = createMockModel({
			responses: [
				// The reminded turn and all three forced turns call `peek` instead.
				{ content: [{ type: "toolCall", id: "p1", name: "peek", arguments: {} }] },
				{ content: [{ type: "toolCall", id: "p2", name: "peek", arguments: {} }] },
				{ content: [{ type: "toolCall", id: "p3", name: "peek", arguments: {} }] },
				{ content: [{ type: "toolCall", id: "p4", name: "peek", arguments: {} }] },
				// The continued run resolves.
				{ content: [{ type: "toolCall", id: "r1", name: "resolve", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const agent = new Agent({ streamFn: mock.stream, getToolChoice: h.getToolChoice });
		agent.setTools(h.tools);

		await agent.prompt("go");
		const failed = agent.state.messages.at(-1);
		expect(failed?.role === "assistant" ? failed.stopReason : undefined).toBe("error");

		// What an automatic retry does: drop the failed turn, then continue the agent.
		agent.replaceMessages(agent.state.messages.slice(0, -1));
		await agent.continue();

		expect(h.peekRuns).toBe(0);
		expect(h.resolveRuns).toBe(1);
	});

	it("leaves tool_choice untouched when no requirement is pending", async () => {
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["hi"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolChoice: () => undefined,
		};

		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]?.options?.toolChoice).toBeUndefined();
	});

	it("reuses the fetched hard tool choice across a Harmony retry instead of re-consuming getToolChoice", async () => {
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [] };
		// Consuming source: yields the forced choice once, then nothing — mirrors
		// coding-agent's ToolChoiceQueue.nextToolChoice advancing its generator.
		const queue: ToolChoice[] = [{ type: "tool", name: "resolve" }];
		const leak = "Some prose. analysis to=functions.edit code 大发官网";
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [{ content: [leak] }, { content: ["clean retry"] }],
		});
		const config: AgentLoopConfig = {
			model: createHarmonyMitigationModel(),
			convertToLlm: identityConverter,
			getToolChoice: () => queue.shift(),
		};

		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		// The leaked attempt was retried; both calls carried the SAME forced choice
		// and the consuming source advanced exactly once (no double-consume).
		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[0]?.options?.toolChoice).toEqual({ type: "tool", name: "resolve" });
		expect(mock.calls[1]?.options?.toolChoice).toEqual({ type: "tool", name: "resolve" });
		expect(queue).toHaveLength(0);
	});
});
