/**
 * Contract: `--mode json` output stays linear in conversation size. Streaming
 * `message_update` events must not re-serialize the in-progress message, and
 * printed messages must not carry provider-opaque replay payloads (encrypted
 * reasoning history), which previously produced multi-GB transcripts.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { printableEvent, runPrintMode } from "../../src/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { DEEP_LEVELS, nestedChain, nestingOf } from "../../../ai/test/helpers/deep-nesting";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "hello" }],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-test",
	usage: {} as AssistantMessage["usage"],
	stopReason: "stop",
	timestamp: 1,
	providerPayload: { type: "openaiResponsesHistory", provider: "openai", dt: true, items: [{ big: "blob" }] },
};

describe("printableEvent", () => {
	it("emits only the incremental delta for message_update", () => {
		const event: AgentSessionEvent = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel", partial: assistant },
		};
		const printed = JSON.parse(JSON.stringify(printableEvent(event)));
		expect(printed).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" },
		});
	});

	it("drops the done-variant message snapshot from message_update", () => {
		const event: AgentSessionEvent = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "done", reason: "stop", message: assistant },
		};
		const printed = JSON.parse(JSON.stringify(printableEvent(event)));
		expect(printed).toEqual({ type: "message_update", assistantMessageEvent: { type: "done", reason: "stop" } });
	});

	it("strips providerPayload from message_end but keeps the message content", () => {
		const event: AgentSessionEvent = { type: "message_end", message: assistant };
		const printed = JSON.parse(JSON.stringify(printableEvent(event))) as {
			message: Record<string, unknown>;
		};
		expect(printed.message.providerPayload).toBeUndefined();
		expect(printed.message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(printed.message.model).toBe("gpt-test");
	});

	it("strips providerPayload from every message in agent_end", () => {
		const event: AgentSessionEvent = { type: "agent_end", messages: [assistant, assistant] };
		const printed = JSON.parse(JSON.stringify(printableEvent(event))) as {
			messages: Array<Record<string, unknown>>;
		};
		expect(printed.messages).toHaveLength(2);
		for (const message of printed.messages) expect(message.providerPayload).toBeUndefined();
	});
});

describe("print mode JSON output", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A tool call's arguments are any JSON, as deep as JSON.parse reads; every event that carries the call is written.
	it("writes an event holding a tool call nested past JSON.stringify's reach", async () => {
		const lines: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, cb?: (err?: Error) => void) => {
			lines.push(String(chunk));
			cb?.();
			return true;
		}) as never);
		const message: AssistantMessage = {
			...assistant,
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { note: nestedChain() } }],
			stopReason: "toolUse",
		};
		let listener: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			extensionRunner: undefined,
			subscribe: (next: (event: AgentSessionEvent) => void) => {
				listener = next;
				return () => {};
			},
			settings: Settings.isolated(),
			sessionManager: {
				getHeader: () => undefined,
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getCwd: () => process.cwd(),
				onPersistenceError: () => () => {},
				onPersistenceNotice: () => () => {},
			},
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForIdle: async () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			prompt: async () => listener?.({ type: "message_end", message }),
			getLastAssistantMessage: () => message,
			dispose: async () => {},
		} as unknown as AgentSession;

		expect(await runPrintMode(session, { mode: "json", messages: ["read it"] })).toBe(0);

		const printed = lines.map(line => JSON.parse(line) as { type: string; message?: AssistantMessage });
		const content = printed.find(event => event.type === "message_end")?.message?.content[0];
		expect(content?.type === "toolCall" && nestingOf(content.arguments.note)).toEqual({
			levels: DEEP_LEVELS,
			bottom: { leaf: "bottom" },
		});
	});
});
