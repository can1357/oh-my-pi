import { describe, expect, it } from "bun:test";
import type { AssistantMessage, StopReason } from "@oh-my-pi/pi-ai";
import {
	REFUSAL_TOOL_CALL_REPORT_TYPE,
	REFUSAL_WAKE_WITHDRAWN_TYPE,
	refusalChainOpen,
	refusalWakeOwed,
} from "@oh-my-pi/pi-coding-agent/session/refusal-chain";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

let nextId = 0;
function base(): { id: string; parentId: string | null; timestamp: string } {
	nextId++;
	return { id: `e${nextId}`, parentId: nextId === 1 ? null : `e${nextId - 1}`, timestamp: new Date().toISOString() };
}

function assistant(stopReason: StopReason, content: AssistantMessage["content"]): SessionEntry {
	return {
		...base(),
		type: "message",
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		},
	} as SessionEntry;
}

function user(content: string): SessionEntry {
	return { ...base(), type: "message", message: { role: "user", content, timestamp: Date.now() } } as SessionEntry;
}

function report(final: boolean): SessionEntry {
	return {
		...base(),
		type: "custom_message",
		customType: REFUSAL_TOOL_CALL_REPORT_TYPE,
		content: "The provider ended your last response with a refusal.",
		details: { final },
		display: false,
	} as SessionEntry;
}

function withdrawn(): SessionEntry {
	return {
		...base(),
		type: "custom_message",
		customType: REFUSAL_WAKE_WITHDRAWN_TYPE,
		content: "The continuation was withdrawn.",
		display: false,
	} as SessionEntry;
}

const text = [{ type: "text" as const, text: "Here is the answer." }];
const toolCall = [{ type: "toolCall" as const, id: "toolu_1", name: "write", arguments: { content: "x" } }];
const unsignedThinking = [{ type: "thinking" as const, thinking: "Considering." }];

describe("refusal chain state, read from the durable branch", () => {
	it("an answered assistant turn ends the chain and the owed wake", () => {
		const entries = [user("Write it"), report(false), assistant("stop", text)];
		expect(refusalChainOpen(entries)).toBe(false);
		expect(refusalWakeOwed(entries)).toBe(false);
	});

	it("a turn that is only tool calls is an answer: content, not emptiness, is the test", () => {
		expect(refusalChainOpen([report(false), assistant("toolUse", toolCall)])).toBe(false);
	});

	for (const [shape, content] of [
		["no content at all", [] as AssistantMessage["content"]],
		["only unsigned reasoning", unsignedThinking],
	] as const) {
		it(`an empty successful turn with ${shape} delivered nothing, so the report stands`, () => {
			// Without this, a provider's clean stop with nothing in it would close the
			// chain on its own and leave the refused calls unreported with no error.
			const entries = [report(false), assistant("stop", content)];
			expect(refusalChainOpen(entries)).toBe(true);
			expect(refusalWakeOwed(entries)).toBe(true);
		});
	}

	for (const stopReason of ["error", "aborted"] as const) {
		it(`an ${stopReason} turn after the report delivered nothing either`, () => {
			// An aborted turn cannot say who aborted it — a user, a compaction, a
			// session switch, an exiting process — so it never withdraws the wake.
			const entries = [report(false), assistant(stopReason, text)];
			expect(refusalChainOpen(entries)).toBe(true);
			expect(refusalWakeOwed(entries)).toBe(true);
		});
	}

	it("a final report owes no wake and keeps the chain open", () => {
		const entries = [report(false), assistant("error", []), report(true)];
		expect(refusalChainOpen(entries)).toBe(true);
		expect(refusalWakeOwed(entries)).toBe(false);
	});

	it("a /clear boundary starts a new history: nothing before it is owed or open", () => {
		const entries = [report(false), { ...base(), type: "reset_boundary" } as SessionEntry];
		expect(refusalChainOpen(entries)).toBe(false);
		expect(refusalWakeOwed(entries)).toBe(false);
	});

	it("a withdrawal note ends the owed wake without ending the chain", () => {
		const entries = [report(false), withdrawn()];
		expect(refusalWakeOwed(entries)).toBe(false);
		expect(refusalChainOpen(entries)).toBe(true);
	});

	it("no message producer ends a chain: a plain user message leaves both unchanged", () => {
		// An SDK resource notification arrives exactly like this. Classifying
		// producers is what rounds 4-6 each got wrong; nothing classifies them now.
		const entries = [report(false), user("[mcp] resource updated: file:///notes.md")];
		expect(refusalChainOpen(entries)).toBe(true);
		expect(refusalWakeOwed(entries)).toBe(true);
	});

	it("a branch that never refused owes nothing", () => {
		const entries = [user("Hello"), assistant("stop", text)];
		expect(refusalChainOpen(entries)).toBe(false);
		expect(refusalWakeOwed(entries)).toBe(false);
	});
});
