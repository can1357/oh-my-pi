// A turn Anthropic refuses after the model has started a tool call stored a
// synthetic not-executed result whose text quoted the refusal, and never
// stored the refused assistant turn. Every later request then replayed that
// orphan as a bare user message, the quoted refusal got the next turn refused,
// and the session could take no turn again — 14 Legion roles in 13 pods on
// 2026-11-04 (INFRA-1191, measured in dispatch://INFRA-1182 over 493 replays).
//
// Three contracts here: the placeholder's model-visible text carries no
// provider words, an orphan is never stored, and a session that already has
// one is healed when it is loaded.
import { describe, expect, it } from "bun:test";
import path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createSyntheticToolResultMessage, isSyntheticToolResultMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildSessionContext, isOrphanedSyntheticResult } from "../../src/session/session-context";
import type { SessionEntry } from "../../src/session/session-entries";
import { loadEntriesFromFile } from "../../src/session/session-loader";
import { migrateToCurrentVersion } from "../../src/session/session-migrations";

// The stand-in for the provider's refusal, as the stored fixtures carry it.
// The real text is withheld on purpose: quoting it in a model's context is the
// trigger this fix exists to remove.
const REFUSAL_MARKER = "STANDIN-REFUSAL-TEXT-d41d8cd98f00";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "refusal-orphans");
const STUCK_SESSIONS = [
	{ file: "infra-317-implementer.jsonl", storedOrphans: 12, realResults: 3 },
	{ file: "infra-771-implementer.jsonl", storedOrphans: 11, realResults: 2 },
	{ file: "infra-839-tester.jsonl", storedOrphans: 5, realResults: 4 },
];

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let nextEntryId = 0;

function entry(message: AgentMessage, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id: `e${++nextEntryId}`,
		parentId,
		timestamp: "2026-11-04T00:00:00.000Z",
		message,
	} as SessionEntry;
}

function chain(messages: AgentMessage[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	for (const message of messages) {
		const next = entry(message, parentId);
		entries.push(next);
		parentId = next.id;
	}
	return entries;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

function assistantWithCall(toolCallId: string, stopReason: AssistantMessage["stopReason"]): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
		usage,
		stopReason,
		timestamp: 2,
	} satisfies AssistantMessage as AgentMessage;
}

function realToolResult(toolCallId: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "a.ts b.ts" }],
		isError: false,
		timestamp: 3,
	} as AgentMessage;
}

function syntheticResult(toolCallId: string): AgentMessage {
	return createSyntheticToolResultMessage(
		{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls" } },
		"error",
		REFUSAL_MARKER,
	) as AgentMessage;
}

function anthropicModel(): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		name: "Claude Test",
		id: "claude-opus-5",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		contextWindow: 200_000,
		maxTokens: 8192,
		input: ["text"],
		reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

async function loadFixture(file: string): Promise<SessionEntry[]> {
	const entries = await loadEntriesFromFile(path.join(FIXTURES, file), undefined, { throwIfMissing: true });
	migrateToCurrentVersion(entries);
	return entries.filter((candidate): candidate is SessionEntry => candidate.type !== "session");
}

describe("synthetic tool result content", () => {
	it("states only that the tool did not run, and keeps the provider's words out of the model's view", () => {
		const result = createSyntheticToolResultMessage(
			{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
			"error",
			REFUSAL_MARKER,
		);

		expect(JSON.stringify(result.content)).not.toContain(REFUSAL_MARKER);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Tool call was not executed because the provider stream ended with an error before the tool could run.",
			},
		]);
		// Local metadata keeps it: the UI, telemetry and ACP still report what
		// the provider said, and no request carries `details`.
		expect(result.details.upstreamError).toBe(REFUSAL_MARKER);
	});
});

describe("isOrphanedSyntheticResult", () => {
	it("flags a placeholder whose refused assistant turn was never stored", () => {
		const branch = chain([userMessage("carry on")]);

		expect(isOrphanedSyntheticResult(branch, syntheticResult("call-1"))).toBe(true);
	});

	it("keeps a placeholder whose assistant turn is stored — the pairing is what decides", () => {
		const branch = chain([userMessage("carry on"), assistantWithCall("call-1", "toolUse")]);

		expect(isOrphanedSyntheticResult(branch, syntheticResult("call-1"))).toBe(false);
	});

	it("keeps a real tool result whatever the branch holds: only placeholders are candidates", () => {
		expect(isOrphanedSyntheticResult(chain([userMessage("carry on")]), realToolResult("call-1"))).toBe(false);
	});

	it("flags a placeholder for a different call than the stored turn made", () => {
		const branch = chain([userMessage("carry on"), assistantWithCall("call-1", "toolUse")]);

		expect(isOrphanedSyntheticResult(branch, syntheticResult("call-2"))).toBe(true);
	});
});

describe("buildSessionContext heals an orphaned placeholder on load", () => {
	it("drops the orphan and leaves the rest of the conversation intact", () => {
		const context = buildSessionContext(
			chain([
				userMessage("first prompt"),
				assistantWithCall("good-1", "toolUse"),
				realToolResult("good-1"),
				userMessage("carry on"),
				// The refused turn was never stored; only its placeholder was.
				syntheticResult("orphan-1"),
				userMessage("next prompt"),
			]),
		);

		expect(context.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
			"user",
		]);
		expect(context.messages.some(message => message.role === "toolResult" && message.toolCallId === "orphan-1")).toBe(
			false,
		);
	});

	it("keeps a placeholder whose assistant turn survives the rebuild", () => {
		// The turn ends in `toolUse`, so nothing else drops it — if the healing
		// pass keyed on "synthetic" rather than on the pairing, this legitimate
		// placeholder would vanish and leave the assistant's call unanswered.
		const context = buildSessionContext(
			chain([
				userMessage("run it"),
				assistantWithCall("call-1", "toolUse"),
				syntheticResult("call-1"),
				userMessage("next prompt"),
			]),
		);

		expect(context.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
	});

	it("keeps every real tool result", () => {
		const context = buildSessionContext(
			chain([
				userMessage("run it"),
				assistantWithCall("call-1", "toolUse"),
				realToolResult("call-1"),
				userMessage("next prompt"),
			]),
		);

		expect(context.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
	});

	it("keeps the orphan visible in the display transcript", () => {
		// Healing is about what the next request carries. The chat must still
		// show that a call was made and did not run.
		const context = buildSessionContext(
			chain([userMessage("carry on"), syntheticResult("orphan-1")]),
			undefined,
			undefined,
			{ transcript: true },
		);

		expect(context.messages.map(message => message.role)).toEqual(["user", "toolResult"]);
	});
});

describe("stored stuck sessions heal when they are loaded", () => {
	for (const { file, storedOrphans, realResults } of STUCK_SESSIONS) {
		it(`${file}: ${storedOrphans} stored orphans dropped, ${realResults} real results kept`, async () => {
			const storedResults = (await loadFixture(file)).flatMap(candidate =>
				candidate.type === "message" && candidate.message.role === "toolResult" ? [candidate.message] : [],
			);
			expect(storedResults.filter(message => isSyntheticToolResultMessage(message))).toHaveLength(storedOrphans);
			expect(storedResults).toHaveLength(storedOrphans + realResults);

			const { messages } = buildSessionContext(await loadFixture(file));

			const replayed = messages.filter(message => message.role === "toolResult");
			expect(replayed.filter(message => isSyntheticToolResultMessage(message))).toHaveLength(0);
			expect(replayed).toHaveLength(realResults);
		});
	}

	it("sends nothing of the provider's refusal in the next request", async () => {
		const entries = await loadFixture("infra-317-implementer.jsonl");
		// The stored file still carries it — the fix rewrites no history.
		expect(JSON.stringify(entries)).toContain(REFUSAL_MARKER);

		const { messages } = buildSessionContext(entries);
		const request = transformMessages([...messages] as Message[], anthropicModel());

		expect(JSON.stringify(request)).not.toContain(REFUSAL_MARKER);
	});
});
