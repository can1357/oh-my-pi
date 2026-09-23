import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AdvisorAgent, AdvisorRuntime, type AdvisorRuntimeHost } from "../src/advisor";

/**
 * `advisor.reviewOn` decides, inside `AdvisorRuntime.onTurnEnd`, whether a
 * mid-turn primary step is worth an advisor request. Skipped steps must stay
 * queued — the review cursor only advances when a delta is actually rendered —
 * and the terminal boundary must always review.
 */

function makeAgent(promptInputs: Array<string | AgentMessage[]>): AdvisorAgent {
	return {
		prompt: async input => {
			promptInputs.push(input);
		},
		abort: () => {},
		reset: () => {},
		state: { messages: [] },
	};
}

function blockText(block: unknown): string {
	if (block && typeof block === "object" && "text" in block && typeof block.text === "string") return block.text;
	return "";
}

function promptText(input: string | AgentMessage[] | undefined): string {
	if (input === undefined) return "";
	if (typeof input === "string") return input;
	return input
		.map(message => {
			if (!("content" in message)) return "";
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) return content.map(blockText).join("\n");
			return "";
		})
		.join("\n");
}

/** A skip leaves nothing to await, so drain the microtask/immediate queue instead. */
async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** One primary tool-call step: assistant turn (marker text + tool call) plus its result. */
function pushStep(messages: AgentMessage[], marker: string, tool: string, args?: Record<string, unknown>): void {
	const id = `${marker}-call`;
	messages.push({
		role: "assistant",
		content: [
			{ type: "text", text: marker },
			{ type: "toolCall", id, name: tool, arguments: args ?? { path: `${marker}.ts` } },
		],
		timestamp: messages.length + 1,
	} as unknown as AgentMessage);
	messages.push({
		role: "toolResult",
		toolCallId: id,
		toolName: tool,
		content: [{ type: "text", text: `${marker}-result` }],
		isError: false,
		timestamp: messages.length + 1,
	} as unknown as AgentMessage);
}

function newRuntime(): {
	runtime: AdvisorRuntime;
	messages: AgentMessage[];
	promptInputs: Array<string | AgentMessage[]>;
} {
	const promptInputs: Array<string | AgentMessage[]> = [];
	const messages: AgentMessage[] = [{ role: "user", content: "do the work", timestamp: 1 } as AgentMessage];
	const host: AdvisorRuntimeHost = { snapshotMessages: () => messages };
	return { runtime: new AdvisorRuntime(makeAgent(promptInputs), host), messages, promptInputs };
}

describe("advisor review cadence", () => {
	it("defers every mid-turn step to the terminal boundary under reviewOn=turn", async () => {
		const { runtime, messages, promptInputs } = newRuntime();

		for (const marker of ["step-alpha", "step-beta", "step-gamma"]) {
			pushStep(messages, marker, "edit");
			runtime.onTurnEnd(messages, { willContinue: true, cadence: "turn" });
			await settle();
			expect(promptInputs).toHaveLength(0);
			// A skipped step must not enqueue work either: the primary never parks
			// on a backlog the cadence decided not to review.
			expect(runtime.backlog).toBe(0);
		}

		runtime.onTurnEnd(messages, { willContinue: false, cadence: undefined });
		await runtime.waitForCatchup(1_000, 1);

		expect(promptInputs).toHaveLength(1);
		const text = promptText(promptInputs[0]);
		// Nothing was lost: the single terminal review carries all three steps.
		expect(text).toContain("step-alpha");
		expect(text).toContain("step-beta");
		expect(text).toContain("step-gamma");
		expect(text).not.toContain("[in progress");
	});

	it("skips read-only mid-turn steps and replays them with the next mutating step under reviewOn=mutation", async () => {
		const { runtime, messages, promptInputs } = newRuntime();

		pushStep(messages, "just-reading", "read");
		runtime.onTurnEnd(messages, { willContinue: true, cadence: "mutation" });
		await settle();
		expect(promptInputs).toHaveLength(0);
		expect(runtime.backlog).toBe(0);

		pushStep(messages, "now-writing", "edit");
		runtime.onTurnEnd(messages, { willContinue: true, cadence: "mutation" });
		await runtime.waitForCatchup(1_000, 1);

		expect(promptInputs).toHaveLength(1);
		const text = promptText(promptInputs[0]);
		expect(text).toContain("now-writing");
		// The skipped read step rides along in the next review.
		expect(text).toContain("just-reading");
		// Still mid-turn: the advisor must know the work is partial.
		expect(text).toContain("[in progress");
	});

	it("reviews every tool outside the read-only carve-out under reviewOn=mutation", async () => {
		// Fail-safe guard: `task` and MCP tools are absent from
		// READ_ONLY_TOOL_NAMES by construction, `lsp` is read-tier for hover but
		// rename/code_actions edit files, and `memory_edit` is read-tier yet
		// writes the durable memory bank. If that set ever grows, this test is
		// what catches an accidentally exempted mutation.
		const { runtime, messages, promptInputs } = newRuntime();

		let expected = 0;
		for (const tool of ["task", "mcp__deploy_release", "lsp", "memory_edit"]) {
			pushStep(messages, `via-${tool}`, tool);
			runtime.onTurnEnd(messages, { willContinue: true, cadence: "mutation" });
			await runtime.waitForCatchup(1_000, 1);
			expected++;
			expect(promptInputs).toHaveLength(expected);
			expect(promptText(promptInputs[expected - 1])).toContain(`via-${tool}`);
		}
	});

	it("exempts hub inspection ops but reviews hub process and coordination ops under reviewOn=mutation", async () => {
		// The hub carve-out is parameter-discriminated, so it is invisible to the
		// tool-name table above: `isHubReviewExempt` must keep inspection out of
		// the advisor's way without hiding a job kill or a peer steer.
		const { runtime, messages, promptInputs } = newRuntime();

		pushStep(messages, "hub-jobs", "hub", { op: "jobs" });
		runtime.onTurnEnd(messages, { willContinue: true, cadence: "mutation" });
		await settle();
		expect(promptInputs).toHaveLength(0);
		expect(runtime.backlog).toBe(0);

		pushStep(messages, "hub-start", "hub", { op: "start", name: "web", application: "bun" });
		runtime.onTurnEnd(messages, { willContinue: true, cadence: "mutation" });
		await runtime.waitForCatchup(1_000, 1);
		expect(promptInputs).toHaveLength(1);
		const text = promptText(promptInputs[0]);
		expect(text).toContain("hub-start");
		// The skipped inspection step still rides along.
		expect(text).toContain("hub-jobs");
	});

	it("reviews hub cancel and peer send even though they need no user confirmation", async () => {
		const { runtime, messages, promptInputs } = newRuntime();

		let expected = 0;
		for (const args of [
			{ op: "cancel", ids: ["job_1"] },
			{ op: "send", to: "Peer", message: "stop" },
		]) {
			pushStep(messages, `hub-${args.op}`, "hub", args);
			runtime.onTurnEnd(messages, { willContinue: true, cadence: "mutation" });
			await runtime.waitForCatchup(1_000, 1);
			expected++;
			expect(promptInputs).toHaveLength(expected);
			expect(promptText(promptInputs[expected - 1])).toContain(`hub-${args.op}`);
		}
	});
});
