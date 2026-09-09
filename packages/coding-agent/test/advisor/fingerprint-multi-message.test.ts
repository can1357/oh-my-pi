// PoC: evaluate which candidate fix prevents advisor full-transcript replays.
// Scenarios reproduce the production triggers observed in the live session
// (omp 17.2.2, omp-cop-sticky / gpt-5.6-terra):
//   A. delivered message replaced by a clone differing only in unrendered
//      fields (timestamp/usage)  -> full-JSON fingerprint mismatch
//   B. delivered message content rewritten to a `[shaken ...]` placeholder
//      (auto-shake mutates in place, then rewriteEntries yields a new object)
//   C. wip heading flip (## Session update [in progress ...] vs final)
//   E. rendered field change (custom.display) must replay
//   F. unrendered field change (usage) must NOT replay under candidate 1
//
// formatSessionHistoryMarkdown folds consecutive user messages into one block,
// so full-vs-incremental is judged by content: `seed-body-001` is never
// mutated by scenarios A/B/F, so its presence proves the whole history was
// re-rendered (full replay); absence means only the new tail shipped.
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

import { type AdvisorAgent, AdvisorRuntime, type AdvisorRuntimeHost } from "../../src/advisor/runtime";

function mkMsg(
	role: AgentMessage["role"],
	text: string,
	timestamp: number,
	extra: Record<string, unknown> = {},
): AgentMessage {
	return { role, content: text, timestamp, ...extra } as AgentMessage;
}

function history(parts: string[]): AgentMessage[] {
	return parts.map((text, i) => mkMsg("user", text, i + 1));
}

async function settle() {
	for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function runScenario(
	seed: AgentMessage[],
	mutate: (messages: AgentMessage[]) => void,
	extraTurn: AgentMessage[],
): Promise<{ prompts: string[] }> {
	const messages: AgentMessage[] = [...seed];
	const prompts: string[] = [];
	const agent: AdvisorAgent = {
		prompt: async (input: string) => {
			prompts.push(input);
		},
		abort: () => {},
		reset: () => {},
		state: { messages: [] },
	} as unknown as AdvisorAgent;
	const host: AdvisorRuntimeHost = {
		snapshotMessages: () => messages,
		enqueueAdvice: () => {},
	} as unknown as AdvisorRuntimeHost;
	const runtime = new AdvisorRuntime(agent, host);
	runtime.onTurnEnd();
	await settle();
	mutate(messages);
	messages.push(...extraTurn);
	runtime.onTurnEnd();
	await settle();
	return { prompts };
}

function promptTextOf(input: string | AgentMessage[]): string {
	if (typeof input === "string") return input;
	return input
		.map(m => {
			const c = (m as { content?: unknown }).content;
			if (typeof c === "string") return c;
			if (Array.isArray(c)) return c.map((b: { text?: string }) => b.text ?? "").join("\n");
			return String(m);
		})
		.join("\n");
}

function describeDelta(prompts: Array<string | AgentMessage[]>): { full: boolean; tailOnly: boolean } {
	if (prompts.length === 0) return { full: false, tailOnly: false };
	const last = promptTextOf(prompts[prompts.length - 1]);
	const full = last.includes("seed-body-001");
	const tailOnly = !full;
	return { full, tailOnly };
}

describe("fingerprint: field-selective fingerprint (applied)", () => {
	it("scenario A: timestamp-only clone replacement is INCREMENTAL (no full replay)", async () => {
		const { prompts } = await runScenario(
			history(["seed-body-000", "seed-body-001"]),
			messages => {
				messages[0] = { ...messages[0], timestamp: 999999 } as AgentMessage;
			},
			[mkMsg("user", "tail-body-002", 3)],
		);
		const d = describeDelta(prompts);
		expect(d.full).toBe(false);
		expect(d.tailOnly).toBe(true);
	});

	it("scenario B: content rewrite to shaken placeholder STILL triggers FULL replay (content is rendered)", async () => {
		const { prompts } = await runScenario(
			history(["seed-body-000", "seed-body-001"]),
			messages => {
				messages[0] = {
					...messages[0],
					content: "[shaken ~10 tokens — recover: artifact://1 (region 1)]",
				} as AgentMessage;
			},
			[mkMsg("user", "tail-body-002", 3)],
		);
		expect(describeDelta(prompts).full).toBe(true);
	});

	it("scenario E: rendered field change (custom.display flip) triggers FULL replay", async () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "xdev-mount-notice",
				content: "seed-body-000",
				display: true,
				timestamp: 1,
			} as unknown as AgentMessage,
			mkMsg("user", "seed-body-001", 2),
		];
		const prompts: string[] = [];
		const agent: AdvisorAgent = {
			prompt: async (input: string) => {
				prompts.push(input);
			},
			abort: () => {},
			reset: () => {},
			state: { messages: [] },
		} as unknown as AdvisorAgent;
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => messages,
			enqueueAdvice: () => {},
		} as unknown as AdvisorRuntimeHost;
		const runtime = new AdvisorRuntime(agent, host);
		runtime.onTurnEnd();
		await settle();
		// Replace with a NEW object whose display flipped (rewriteEntries clone).
		messages[0] = { ...messages[0], display: false } as unknown as AgentMessage;
		messages.push(mkMsg("user", "tail-body-002", 3));
		runtime.onTurnEnd();
		await settle();
		const last = promptTextOf(prompts[prompts.length - 1]);
		// display is rendered (folding gate); flipping it must re-render history.
		expect(last).toContain("seed-body-001");
	});

	it("scenario F: unrendered field change (usage) does NOT trigger replay", async () => {
		const { prompts } = await runScenario(
			history(["seed-body-000", "seed-body-001"]),
			messages => {
				messages[0] = { ...messages[0], usage: { input_tokens: 123 } } as unknown as AgentMessage;
			},
			[mkMsg("user", "tail-body-002", 3)],
		);
		const d = describeDelta(prompts);
		expect(d.full).toBe(false);
		expect(d.tailOnly).toBe(true);
	});

	it("scenario G: rendered field change (bashExecution.command) triggers FULL replay", async () => {
		// command is rendered by formatSessionHistoryMarkdown (executionLine), so
		// a clone changing only command must not pass the prefix check.
		const { prompts } = await runScenario(
			[mkMsg("bashExecution", "", 1, { command: "ls -la" }), mkMsg("user", "seed-body-001", 2)],
			messages => {
				messages[0] = { ...messages[0], command: "ls -la /tmp" } as unknown as AgentMessage;
			},
			[mkMsg("user", "tail-body-002", 3)],
		);
		expect(describeDelta(prompts).full).toBe(true);
	});

	it("scenario H: rendered field change (compaction summary) triggers FULL replay", async () => {
		const { prompts } = await runScenario(
			[mkMsg("compactionSummary", "", 1, { summary: "seed summary" }), mkMsg("user", "seed-body-001", 2)],
			messages => {
				messages[0] = { ...messages[0], summary: "rewritten summary" } as unknown as AgentMessage;
			},
			[mkMsg("user", "tail-body-002", 3)],
		);
		expect(describeDelta(prompts).full).toBe(true);
	});
});
