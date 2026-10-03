import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { SpeculativeOperationCoordinator } from "@oh-my-pi/pi-agent-core/speculative-execution";
import type { AgentContext, AgentLoopConfig, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

const schema = type({ path: "string" });

interface CommitGateHarness {
	tool: AgentTool<typeof schema>;
	coordinator: SpeculativeOperationCoordinator;
	file: { content: string; version: number };
	speculativeExecutions: string[];
	ordinaryExecutions: string[];
}

function setup(): CommitGateHarness {
	// Simulated versioned file: the speculative read snapshots content+digest
	// at execution time; host validation compares the snapshot digest against
	// the live version, vetoing when the file changed after execution.
	const file = { content: "parent-content", version: 1 };
	const speculativeExecutions: string[] = [];
	const ordinaryExecutions: string[] = [];
	const tool: AgentTool<typeof schema> = {
		name: "read",
		label: "Read",
		description: "Versioned file read for commit-gate tests",
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
					speculativeExecutions.push(String(args.path));
					return {
						kind: "result",
						result: { content: [{ type: "text", text: `${file.content}#v${file.version}` }] },
						isError: false,
					};
				},
			},
		},
		async execute(_toolCallId, args) {
			ordinaryExecutions.push(args.path);
			return { content: [{ type: "text", text: `${file.content}#v${file.version}` }] };
		},
	};
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
	const loopConfig: AgentLoopConfig = {
		model: createMockModel({ responses: [] }).model,
		convertToLlm: messages =>
			messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[],
	};
	const coordinator = new SpeculativeOperationCoordinator(
		{
			enabled: true,
			host: {
				authorize: () => ({ allowed: true }),
				validate: ({ physicalOutcome }) => {
					const text = physicalOutcome.result.content.find(entry => entry.type === "text")?.text ?? "";
					const digest = text.match(/#v(\d+)$/)?.[1];
					if (digest === undefined) return true;
					return Number(digest) === file.version;
				},
			},
		},
		{ context, loopConfig },
	);
	return { tool, coordinator, file, speculativeExecutions, ordinaryExecutions };
}

describe("speculative commit gate", () => {
	it("discards result-dependent children without executing when the parent commit is vetoed", async () => {
		const { tool, coordinator, file, speculativeExecutions, ordinaryExecutions } = setup();
		const parent = await coordinator.admit({
			candidateId: "parent",
			parentToolCallId: "eval-1",
			dependencies: [],
			toolCall: { type: "toolCall", id: "parent-call", name: "read", arguments: { path: "/tmp/parent.txt" } },
			tool,
			source: "eval_shadow",
		});
		await coordinator.finalizeAdmissions();

		const parentOutcome = await parent?.outcome;
		expect(parentOutcome?.kind).toBe("result");

		// Dependent read whose args derive from the parent's speculative result.
		const parentText =
			parentOutcome?.kind === "result"
				? (parentOutcome.result.content.find(entry => entry.type === "text")?.text ?? "")
				: "";
		const childArgs = { path: `/tmp/derived-${parentText}.txt` };
		const child = await coordinator.admit({
			candidateId: "child",
			parentToolCallId: "eval-1",
			dependencies: ["parent"],
			toolCall: { type: "toolCall", id: "child-call", name: "read", arguments: childArgs },
			tool,
			source: "eval_shadow",
		});

		// The file changes after speculative execution but before commit, so
		// host validation vetoes the parent's stale snapshot.
		file.content = "rewritten-content";
		file.version = 2;

		await expect(parent?.commit({ path: "/tmp/parent.txt" })).resolves.toBeUndefined();
		await expect(child?.outcome).rejects.toThrow(/dependency parent/);
		await expect(child?.commit(childArgs)).resolves.toBeUndefined();

		// The dependent must never have touched the derived path: it is
		// discarded on the veto instead of consuming the stale result.
		expect(speculativeExecutions).toEqual(["/tmp/parent.txt"]);

		const fallback = await tool.execute("parent-call", { path: "/tmp/parent.txt" });
		expect(ordinaryExecutions).toEqual(["/tmp/parent.txt"]);
		expect(fallback.content.find(entry => entry.type === "text")?.text).toBe("rewritten-content#v2");
		await coordinator.close("test complete");
	});

	it("runs and claims dependents once their dependencies commit", async () => {
		const { tool, coordinator, speculativeExecutions } = setup();
		const parent = await coordinator.admit({
			candidateId: "parent",
			parentToolCallId: "eval-1",
			dependencies: [],
			toolCall: { type: "toolCall", id: "parent-call", name: "read", arguments: { path: "/tmp/parent.txt" } },
			tool,
			source: "eval_shadow",
		});
		await coordinator.finalizeAdmissions();

		const parentOutcome = await parent?.outcome;
		expect(parentOutcome?.kind).toBe("result");
		const parentText =
			parentOutcome?.kind === "result"
				? (parentOutcome.result.content.find(entry => entry.type === "text")?.text ?? "")
				: "";
		const childArgs = { path: `/tmp/derived-${parentText}.txt` };
		const child = await coordinator.admit({
			candidateId: "child",
			parentToolCallId: "eval-1",
			dependencies: ["parent"],
			toolCall: { type: "toolCall", id: "child-call", name: "read", arguments: childArgs },
			tool,
			source: "eval_shadow",
		});

		// Stable file: the parent commits, which releases the queued dependent.
		const committed = await parent?.commit({ path: "/tmp/parent.txt" });
		expect(committed?.content.find(entry => entry.type === "text")?.text).toBe("parent-content#v1");

		const childOutcome = await child?.outcome;
		expect(childOutcome?.kind).toBe("result");
		const claimed = await child?.commit(childArgs);
		expect(claimed?.content.find(entry => entry.type === "text")?.text).toBe("parent-content#v1");
		expect(speculativeExecutions).toEqual(["/tmp/parent.txt", childArgs.path]);
		// Already-committed fast path: a dependent admitted after its
		// dependency committed starts without waiting for another release.
		const grandchild = await coordinator.admit({
			candidateId: "grandchild",
			parentToolCallId: "eval-1",
			dependencies: ["child"],
			toolCall: {
				type: "toolCall",
				id: "grandchild-call",
				name: "read",
				arguments: { path: "/tmp/grandchild.txt" },
			},
			tool,
			source: "eval_shadow",
		});
		const grandchildOutcome = await grandchild?.outcome;
		expect(grandchildOutcome?.kind).toBe("result");
		expect(speculativeExecutions).toEqual(["/tmp/parent.txt", childArgs.path, "/tmp/grandchild.txt"]);
		await coordinator.close("test complete");
	});
});
