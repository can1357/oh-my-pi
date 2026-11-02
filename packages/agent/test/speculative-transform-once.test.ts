import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import { SpeculativeOperationCoordinator } from "@oh-my-pi/pi-agent-core/speculative-execution";
import type { AgentTool, AgentMessage, AgentContext, AgentLoopConfig } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

// Identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("speculative transform reuse", () => {
	it("applies a stateful transform exactly once for an admitted direct read", async () => {
		const schema = type({ path: "string" });
		let transformCalls = 0;
		let hookCalls = 0;
		const speculativePaths: string[] = [];
		const ordinaryPaths: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "read_once",
			label: "ReadOnce",
			description: "Records the path speculative execution accessed",
			parameters: schema,
			speculation: {
				finalized: {
					assess: ({ args }) =>
						typeof args.path === "string"
							? {
									eligible: true,
									effect: {
										kind: "local_read",
										resources: [{ scheme: "file", path: args.path, access: "read" }],
									},
								}
							: { eligible: false, reason: "path must be a string" },
					async execute({ args }) {
						speculativePaths.push(String(args.path));
						return {
							kind: "result",
							result: { content: [{ type: "text", text: "speculative result" }] },
							isError: false,
						};
					},
				},
			},
			async execute(_toolCallId, args) {
				ordinaryPaths.push(args.path);
				return { content: [{ type: "text", text: "ordinary result" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "read-once-1", name: "read_once", arguments: { path: "/tmp/spec-once" } },
					],
				},
				{ content: ["done"] },
			],
		});

		await agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				transformToolCallArguments: args => ({ ...args, path: `${String(args.path)}#t${++transformCalls}` }),
				beforeToolCall: async () => {
					hookCalls++;
				},
				speculativeToolExecution: {
					enabled: true,
					host: { authorize: () => ({ allowed: true, deferBeforeToolCall: true }) },
				},
			},
			undefined,
			mock.stream,
		).result();

		// The beforeToolCall gate still runs: reuse must not bypass hook policy.
		expect(hookCalls).toBe(1);
		// Admission ran the stateful transform once; reconciliation and dispatch
		// must reuse that result instead of applying it again.
		expect(transformCalls).toBe(1);
		expect(speculativePaths).toEqual(["/tmp/spec-once#t1"]);
		expect(ordinaryPaths).toEqual([]);
	});

	it("discards the stale speculative result when beforeToolCall revises admitted args", async () => {
		const schema = type({ path: "string" });
		let transformCalls = 0;
		const speculativePaths: string[] = [];
		const ordinaryPaths: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "read_revise",
			label: "ReadRevise",
			description: "Records the path each execution lane accessed",
			parameters: schema,
			speculation: {
				finalized: {
					assess: ({ args }) =>
						typeof args.path === "string"
							? {
									eligible: true,
									effect: {
										kind: "local_read",
										resources: [{ scheme: "file", path: args.path, access: "read" }],
									},
								}
							: { eligible: false, reason: "path must be a string" },
					async execute({ args }) {
						speculativePaths.push(String(args.path));
						return {
							kind: "result",
							result: { content: [{ type: "text", text: "speculative result" }] },
							isError: false,
						};
					},
				},
			},
			async execute(_toolCallId, args) {
				ordinaryPaths.push(args.path);
				return { content: [{ type: "text", text: "ordinary result" }] };
			},
		};
		const transformToolCallArguments = (
			args: Record<string, unknown>,
			_toolName: string,
		): Record<string, unknown> => ({
			...args,
			path: `${String(args.path)}#t${++transformCalls}`,
		});
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const loopConfig: AgentLoopConfig = {
			model: createMockModel({ responses: [] }).model,
			convertToLlm: identityConverter,
			transformToolCallArguments,
		};
		const coordinator = new SpeculativeOperationCoordinator(
			{ enabled: true, host: { authorize: () => ({ allowed: true }) } },
			{ context, loopConfig },
		);
		const toolCall = {
			type: "toolCall" as const,
			id: "read-revise-1",
			name: "read_revise",
			arguments: { path: "/tmp/spec-original" },
		};

		coordinator.admitFinalized(context, toolCall, loopConfig, undefined);
		await coordinator.settleAdmissions();

		// Admission transformed the original path exactly once and speculated on it.
		expect(transformCalls).toBe(1);
		expect(speculativePaths).toEqual(["/tmp/spec-original#t1"]);

		// `prepareToolCallDispatch()` mutates the aliased finalized block in place
		// when `beforeToolCall` returns replacement arguments.
		toolCall.arguments = { path: "/tmp/spec-replacement" };

		// The revision must force a fresh transform, never reuse of stale admission args.
		expect(coordinator.directExecutionArgsFor(toolCall.id, toolCall.arguments)).toBeUndefined();
		const freshArgs = transformToolCallArguments(toolCall.arguments, toolCall.name);
		expect(transformCalls).toBe(2);

		// Reconciliation drops the stale candidate, so its result can never commit.
		await coordinator.reconcileFinalCalls(new Map([[toolCall.id, { ...toolCall, arguments: freshArgs }]]));
		expect(coordinator.size).toBe(0);
		await expect(coordinator.claim(tool, toolCall, freshArgs)).resolves.toBeUndefined();

		// Ordinary dispatch executes the hook-approved replacement with fresh args.
		await tool.execute(toolCall.id, { path: "/tmp/spec-replacement#t2" });
		expect(ordinaryPaths).toEqual(["/tmp/spec-replacement#t2"]);
		await coordinator.close("test complete");
	});
});
