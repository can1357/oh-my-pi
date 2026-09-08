import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
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
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createUserMessage } from "./helpers";

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
		const writeRuns: string[] = [];
		const reminder = createUserMessage("<system-reminder>Write the resolution to /xdev/resolve.</system-reminder>");
		const writeSchema = type({ path: "string" });
		const writeTool: AgentTool<typeof writeSchema, Record<string, never>> = {
			name: "write",
			label: "Write",
			description: "Write a file or device",
			parameters: writeSchema,
			async execute(_id, args) {
				writeRuns.push(args.path);
				if (args.path === "/xdev/resolve") pendingPreview = false;
				return { content: [{ type: "text", text: "written" }], details: {} };
			},
		};
		const getToolChoice = (): SoftToolRequirement | undefined =>
			pendingPreview
				? {
						soft: true,
						id: "preview-1",
						toolName: "write",
						satisfies: toolCall => toolCall.name === "write" && toolCall.arguments?.path === "/xdev/resolve",
						reminder: [reminder],
					}
				: undefined;
		const context: AgentContext = { systemPrompt: ["sys"], messages: [], tools: [writeTool] };
		const mock = createMockModel({
			responses: [
				// Turn 1: right tool name, wrong target — the predicate rejects it.
				{ content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "/tmp/out.md" } }] },
				// Turn 2: forced to write; this call satisfies the predicate.
				{ content: [{ type: "toolCall", id: "w2", name: "write", arguments: { path: "/xdev/resolve" } }] },
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

		// The non-satisfying write was skipped, not executed; only the device write ran.
		expect(writeRuns).toEqual(["/xdev/resolve"]);
		// Escalation still forces the requirement's toolName.
		expect(mock.calls[0]?.options?.toolChoice).toBeUndefined();
		expect(mock.calls[1]?.options?.toolChoice).toEqual({ type: "tool", name: "write" });
		// The skipped write call still produced a paired tool result (API pairing).
		const skipped = messages.find(m => m.role === "toolResult" && m.toolCallId === "w1");
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
			model: buildModel({ ...getBundledModel("openai-codex", "gpt-5.4") }),
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
