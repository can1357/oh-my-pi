import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as terminalCapabilities from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	MessageStartEvent,
	SessionBranchEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	ToolApprovalRequestedEvent,
} from "../../src/extensibility/extensions/types";
import { createWarpEventBridgeExtension, createWarpEventEmitter } from "../../src/modes/warp-events";
import { SILENT_ABORT_MARKER, SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../src/session/messages";

const originalTerminalId = terminalCapabilities.TERMINAL.id;
const originalProtocolVersion = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
const project = path.basename(process.cwd());
const OSC_PREFIX = "\x1b]777;notify;warp://cli-agent;";

type RegisteredHandler = (...args: never[]) => void;

function enableWarpProtocol(terminalId = "warp"): void {
	Object.defineProperty(terminalCapabilities.TERMINAL, "id", { value: terminalId, configurable: true });
	process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
}

function restoreProtocolEnvironment(): void {
	Object.defineProperty(terminalCapabilities.TERMINAL, "id", { value: originalTerminalId, configurable: true });
	if (originalProtocolVersion === undefined) {
		delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	} else {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = originalProtocolVersion;
	}
}

function createHandlers(): Map<string, RegisteredHandler> {
	const handlers = new Map<string, RegisteredHandler>();
	const api = {
		on(event: string, handler: RegisteredHandler): void {
			handlers.set(event, handler);
		},
	} as never as ExtensionAPI;
	createWarpEventBridgeExtension()(api);
	return handlers;
}

function parseBodies(write: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
	return write.mock.calls.map(call => {
		const osc = call[0] as string;
		return JSON.parse(osc.slice(OSC_PREFIX.length, osc.length - 1)) as Record<string, unknown>;
	});
}

function userMessageStart(text: string, overrides: Partial<MessageStartEvent["message"]> = {}): MessageStartEvent {
	return {
		type: "message_start",
		message: {
			role: "user",
			content: text,
			timestamp: Date.now(),
			...overrides,
		} as MessageStartEvent["message"],
	};
}

function skillPromptStart(text: string, attribution: "user" | "agent" = "user"): MessageStartEvent {
	return {
		type: "message_start",
		message: {
			role: "custom",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: text,
			display: true,
			attribution,
			timestamp: Date.now(),
		} as MessageStartEvent["message"],
	};
}

function bridgeContext(sessionId = "session-123", cwd = process.cwd()): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => cwd,
		},
	} as never as ExtensionContext;
}

afterEach(() => {
	vi.restoreAllMocks();
	restoreProtocolEnvironment();
});

describe("Warp CLI-agent events", () => {
	it("emits an exact OSC 777 stop event", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const emitter = createWarpEventEmitter({ sessionId: "session-123" });

		emitter?.emit({ event: "stop" });

		const expectedBody = JSON.stringify({
			event: "stop",
			v: 1,
			agent: "omp",
			session_id: "session-123",
			cwd: process.cwd(),
			project,
			plugin_version: VERSION,
		});
		expect(write).toHaveBeenCalledWith(`${OSC_PREFIX}${expectedBody}\x07`);
	});

	it("wraps OSC output when running inside tmux", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const tmux = vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(true);
		const wrap = vi.spyOn(terminalCapabilities, "wrapTmuxPassthrough");
		const emitter = createWarpEventEmitter({ sessionId: "session-123" });

		emitter?.emit({ event: "stop" });

		expect(tmux).toHaveBeenCalledTimes(1);
		expect(wrap).toHaveBeenCalledWith(expect.stringContaining("warp://cli-agent"));
		const written = write.mock.calls[0]?.[0] as string;
		// Real DCS wrap ends with ST; attention events append outer BEL after it.
		expect(written.startsWith("\x1bPtmux;")).toBe(true);
		expect(written.endsWith("\x1b\\\x07")).toBe(true);
	});

	const attentionEvents = ["stop", "stop_failure", "permission_request", "question_asked"] as const;
	const nonAttentionEvents = [
		"session_start",
		"prompt_submit",
		"tool_complete",
		"permission_replied",
		"custom_event",
	] as const;

	for (const eventName of attentionEvents) {
		it(`rings tmux outer BEL for attention event ${eventName}`, () => {
			enableWarpProtocol();
			const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(true);
			const emitter = createWarpEventEmitter({ sessionId: "session-123" });

			emitter?.emit({ event: eventName });

			const written = write.mock.calls[0]?.[0] as string;
			// Outer BEL after DCS ST; OSC's own \x07 is interior to the passthrough.
			expect(written.startsWith("\x1bPtmux;")).toBe(true);
			expect(written.endsWith("\x07\x1b\\\x07")).toBe(true);
			expect(written.slice(0, -1).endsWith("\x07\x1b\\")).toBe(true);
		});
	}

	for (const eventName of nonAttentionEvents) {
		it(`does not ring tmux outer BEL for non-attention event ${eventName}`, () => {
			enableWarpProtocol();
			const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(true);
			const emitter = createWarpEventEmitter({ sessionId: "session-123" });

			emitter?.emit({ event: eventName });

			const written = write.mock.calls[0]?.[0] as string;
			// DCS ST only — OSC terminator is inside the wrap, not an outer BEL.
			expect(written.startsWith("\x1bPtmux;")).toBe(true);
			expect(written.endsWith("\x07\x1b\\")).toBe(true);
			expect(written.endsWith("\x07\x1b\\\x07")).toBe(false);
		});
	}

	it("leaves direct-terminal OSC unchanged without outer BEL after OSC terminator", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const wrap = vi.spyOn(terminalCapabilities, "wrapTmuxPassthrough");
		const emitter = createWarpEventEmitter({ sessionId: "session-123" });

		for (const eventName of [...attentionEvents, ...nonAttentionEvents]) {
			write.mockClear();
			emitter?.emit({ event: eventName });
			const written = write.mock.calls[0]?.[0] as string;
			expect(written.startsWith(OSC_PREFIX)).toBe(true);
			expect(written.endsWith("\x07")).toBe(true);
			// Exactly one trailing BEL (OSC terminator), not an extra attention BEL.
			expect(written.endsWith("\x07\x07")).toBe(false);
			expect(wrap).not.toHaveBeenCalled();
		}
	});

	it("creates an emitter from protocol version alone even when terminal id is base", () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		enableWarpProtocol("base");

		const emitter = createWarpEventEmitter({ sessionId: "session-123" });
		expect(emitter).toBeDefined();
		emitter?.emit({ event: "stop" });

		const body = parseBodies(write)[0];
		expect(body).toMatchObject({
			event: "stop",
			session_id: "session-123",
			project,
		});
	});

	it("does not emit without a negotiated protocol version", () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		enableWarpProtocol();

		delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
		expect(createWarpEventEmitter({ sessionId: "session-123" })).toBeUndefined();

		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "0";
		expect(createWarpEventEmitter({ sessionId: "session-123" })).toBeUndefined();

		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "not-a-number";
		expect(createWarpEventEmitter({ sessionId: "session-123" })).toBeUndefined();
		expect(write).not.toHaveBeenCalled();
	});

	it("uses session cwd for envelope cwd and project", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const sessionCwd = "/tmp/session-project-root";
		const sessionProject = path.basename(sessionCwd);

		const emitter = createWarpEventEmitter({
			sessionId: "session-123",
			getCwd: () => sessionCwd,
		});
		emitter?.emit({ event: "stop" });

		const directBody = parseBodies(write)[0];
		expect(directBody).toMatchObject({
			event: "stop",
			cwd: sessionCwd,
			project: sessionProject,
		});
		expect(directBody?.cwd).not.toBe(process.cwd());

		write.mockClear();
		const handlers = createHandlers();
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		sessionStart({ type: "session_start" }, bridgeContext("session-123", sessionCwd));
		const body = parseBodies(write)[0];
		expect(body).toMatchObject({
			event: "session_start",
			cwd: sessionCwd,
			project: sessionProject,
		});
	});

	it("does not resubmit prompts for agent continuations", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = createHandlers();
		const context = bridgeContext();
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const messageStart = handlers.get("message_start") as never as (event: MessageStartEvent) => void;
		const agentEnd = handlers.get("agent_end") as never as (event: AgentEndEvent) => void;

		sessionStart({ type: "session_start" }, context);
		write.mockClear();

		messageStart(userMessageStart("first user prompt"));
		// Continuations re-emit agent_start without a user message_start; the bridge must not listen.
		expect(handlers.has("agent_start")).toBe(false);
		const writesAfterSubmit = write.mock.calls.length;
		const agentStart = handlers.get("agent_start") as never as ((event: AgentStartEvent) => void) | undefined;
		agentStart?.({ type: "agent_start" });
		expect(write.mock.calls.length).toBe(writesAfterSubmit);
		agentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] } as never],
		});

		const bodies = parseBodies(write);
		expect(bodies.filter(body => body.event === "prompt_submit")).toEqual([
			expect.objectContaining({ event: "prompt_submit", query: "first user prompt", project }),
		]);
		expect(bodies.at(-1)).toMatchObject({
			event: "stop",
			query: "first user prompt",
			response: "done",
			project,
		});
	});

	it("keeps the active query until queued follow-up begins", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = createHandlers();
		const context = bridgeContext();
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const messageStart = handlers.get("message_start") as never as (event: MessageStartEvent) => void;
		const agentEnd = handlers.get("agent_end") as never as (event: AgentEndEvent) => void;
		const input = handlers.get("input") as never as ((event: InputEvent) => void) | undefined;

		sessionStart({ type: "session_start" }, context);
		write.mockClear();

		// Early queued input must not overwrite the current response's query.
		messageStart(userMessageStart("prompt A"));
		input?.({ type: "input", text: "prompt B", source: "interactive" });
		agentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "answer A" }] } as never],
		});

		let bodies = parseBodies(write);
		expect(bodies).toEqual([
			expect.objectContaining({ event: "prompt_submit", query: "prompt A", project }),
			expect.objectContaining({ event: "stop", query: "prompt A", response: "answer A", project }),
		]);

		// After A ends, B's real user message_start owns submit/stop.
		write.mockClear();
		messageStart(userMessageStart("prompt B"));
		agentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "answer B" }] } as never],
		});
		bodies = parseBodies(write);
		expect(bodies).toEqual([
			expect.objectContaining({ event: "prompt_submit", query: "prompt B", project }),
			expect.objectContaining({ event: "stop", query: "prompt B", response: "answer B", project }),
		]);

		// Normal drain: B's message_start arrives before agent_end, so the final pair is B.
		write.mockClear();
		messageStart(userMessageStart("prompt C"));
		messageStart(userMessageStart("prompt D"));
		agentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "answer D" }] } as never],
		});
		bodies = parseBodies(write);
		expect(bodies).toEqual([
			expect.objectContaining({ event: "prompt_submit", query: "prompt C", project }),
			expect.objectContaining({ event: "prompt_submit", query: "prompt D", project }),
			expect.objectContaining({ event: "stop", query: "prompt D", response: "answer D", project }),
		]);
	});

	it("ignores agent-attributed user-role steers", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = createHandlers();
		const context = bridgeContext();
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const messageStart = handlers.get("message_start") as never as (event: MessageStartEvent) => void;
		const agentEnd = handlers.get("agent_end") as never as (event: AgentEndEvent) => void;

		sessionStart({ type: "session_start" }, context);
		write.mockClear();

		messageStart(userMessageStart("prompt A"));
		messageStart(userMessageStart("agent steer", { attribution: "agent" }));
		agentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "answer A" }] } as never],
		});

		const bodies = parseBodies(write);
		expect(bodies.filter(body => body.event === "prompt_submit")).toEqual([
			expect.objectContaining({ event: "prompt_submit", query: "prompt A", project }),
		]);
		expect(bodies.at(-1)).toMatchObject({
			event: "stop",
			query: "prompt A",
			response: "answer A",
			project,
		});
	});

	it("treats user-attributed skill prompts as submissions", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = createHandlers();
		const context = bridgeContext();
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const messageStart = handlers.get("message_start") as never as (event: MessageStartEvent) => void;
		const agentEnd = handlers.get("agent_end") as never as (event: AgentEndEvent) => void;

		sessionStart({ type: "session_start" }, context);
		write.mockClear();

		messageStart(skillPromptStart("skill body as query", "user"));
		agentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "skill answer" }] } as never],
		});

		let bodies = parseBodies(write);
		expect(bodies).toEqual([
			expect.objectContaining({ event: "prompt_submit", query: "skill body as query", project }),
			expect.objectContaining({
				event: "stop",
				query: "skill body as query",
				response: "skill answer",
				project,
			}),
		]);

		// Agent-attributed skill-shaped custom messages are not user submissions.
		write.mockClear();
		messageStart(userMessageStart("prompt A"));
		messageStart(skillPromptStart("auto skill", "agent"));
		agentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "answer A" }] } as never],
		});
		bodies = parseBodies(write);
		expect(bodies.filter(body => body.event === "prompt_submit")).toEqual([
			expect.objectContaining({ event: "prompt_submit", query: "prompt A", project }),
		]);
		expect(bodies.at(-1)).toMatchObject({
			event: "stop",
			query: "prompt A",
			response: "answer A",
			project,
		});
	});

	it("falls back to non-silent assistant errorMessage on empty stop responses", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = createHandlers();
		const context = bridgeContext();
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const messageStart = handlers.get("message_start") as never as (event: MessageStartEvent) => void;
		const agentEnd = handlers.get("agent_end") as never as (event: AgentEndEvent) => void;

		sessionStart({ type: "session_start" }, context);
		write.mockClear();

		messageStart(userMessageStart("prompt error"));
		agentEnd({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "rate limited",
				} as never,
			],
		});
		expect(parseBodies(write).at(-1)).toMatchObject({
			event: "stop_failure",
			error_type: "error",
			query: "prompt error",
			response: "rate limited",
		});

		// Normal text content is preferred over errorMessage; error stopReason still fails the turn.
		write.mockClear();
		messageStart(userMessageStart("prompt text"));
		agentEnd({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "visible answer" }],
					stopReason: "error",
					errorMessage: "rate limited",
				} as never,
			],
		});
		expect(parseBodies(write).at(-1)).toMatchObject({
			event: "stop_failure",
			error_type: "error",
			query: "prompt text",
			response: "visible answer",
		});

		// Silent abort marker must not surface as the stop response or fail the turn.
		write.mockClear();
		messageStart(userMessageStart("prompt silent"));
		agentEnd({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "aborted",
					errorMessage: SILENT_ABORT_MARKER,
				} as never,
			],
		});
		expect(parseBodies(write).at(-1)).toMatchObject({
			event: "stop",
			query: "prompt silent",
			response: "",
		});
		expect(parseBodies(write).at(-1)).not.toHaveProperty("error_type");

		// User interrupt labels stay suppressed; non-user abort reasons surface as failures.
		write.mockClear();
		messageStart(userMessageStart("prompt interrupt"));
		agentEnd({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "aborted",
					errorMessage: USER_INTERRUPT_LABEL,
				} as never,
			],
		});
		expect(parseBodies(write).at(-1)).toMatchObject({
			event: "stop",
			query: "prompt interrupt",
			response: "",
		});

		write.mockClear();
		messageStart(userMessageStart("prompt aborted"));
		agentEnd({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "aborted",
					errorMessage: "provider cancelled stream",
				} as never,
			],
		});
		expect(parseBodies(write).at(-1)).toMatchObject({
			event: "stop_failure",
			error_type: "aborted",
			query: "prompt aborted",
			response: "provider cancelled stream",
		});
	});

	it("suppresses stop OSC when agent_end willContinue", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = createHandlers();
		const context = bridgeContext();
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const messageStart = handlers.get("message_start") as never as (event: MessageStartEvent) => void;
		const agentEnd = handlers.get("agent_end") as never as (event: AgentEndEvent) => void;

		sessionStart({ type: "session_start" }, context);
		write.mockClear();

		messageStart(userMessageStart("retry me"));
		const afterSubmit = write.mock.calls.length;
		agentEnd({
			type: "agent_end",
			willContinue: true,
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "rate limited",
				} as never,
			],
		});
		expect(write.mock.calls.length).toBe(afterSubmit);
		expect(parseBodies(write).some(body => body.event === "stop" || body.event === "stop_failure")).toBe(false);

		// Without the flag, the same messages still emit a terminal failure stop.
		write.mockClear();
		messageStart(userMessageStart("final error"));
		agentEnd({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "rate limited",
				} as never,
			],
		});
		expect(parseBodies(write).at(-1)).toMatchObject({
			event: "stop_failure",
			query: "final error",
			response: "rate limited",
		});
	});

	it("caps prompt queries and stop responses at 200 Unicode code points without breaking JSON", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = createHandlers();
		const context = bridgeContext();
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const messageStart = handlers.get("message_start") as never as (event: MessageStartEvent) => void;
		const agentEnd = handlers.get("agent_end") as never as (event: AgentEndEvent) => void;

		sessionStart({ type: "session_start" }, context);
		write.mockClear();

		const query = `${"q".repeat(199)}😀tail`;
		const response = `${"a".repeat(199)}😀tail`;
		messageStart(userMessageStart(query));
		agentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: response }] } as never],
		});

		const bodies = parseBodies(write);
		const promptSubmit = bodies.find(body => body.event === "prompt_submit");
		const stop = bodies.find(body => body.event === "stop");
		expect(promptSubmit?.query).toBe(`${"q".repeat(199)}😀`);
		expect(Array.from(promptSubmit?.query as string)).toHaveLength(200);
		expect(stop?.query).toBe(`${"q".repeat(199)}😀`);
		expect(stop?.response).toBe(`${"a".repeat(199)}😀`);
		expect(Array.from(stop?.response as string)).toHaveLength(200);
	});

	it("rebuilds the emitter and resets prompt state after a session switch", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = createHandlers();
		let sessionId = "session-old";
		const context = {
			sessionManager: {
				getSessionId: () => sessionId,
				getCwd: () => process.cwd(),
			},
		} as never as ExtensionContext;
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const sessionSwitch = handlers.get("session_switch") as never as (
			event: SessionSwitchEvent,
			context: ExtensionContext,
		) => void;
		const messageStart = handlers.get("message_start") as never as (event: MessageStartEvent) => void;
		const agentEnd = handlers.get("agent_end") as never as (event: AgentEndEvent) => void;

		sessionStart({ type: "session_start" }, context);
		messageStart(userMessageStart("old prompt"));
		sessionId = "session-new";
		write.mockClear();

		sessionSwitch({ type: "session_switch", reason: "new", previousSessionFile: undefined }, context);
		agentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "orphan stop" }] } as never],
		});

		const bodies = parseBodies(write);
		expect(bodies).toEqual([
			expect.objectContaining({ event: "session_start", session_id: "session-new", project }),
			expect.objectContaining({
				event: "stop",
				session_id: "session-new",
				response: "orphan stop",
				project,
			}),
		]);
		expect(bodies[1]).not.toHaveProperty("query");
	});

	it("rebuilds the emitter and resets prompt state after a session branch", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = createHandlers();
		let sessionId = "session-old";
		const context = {
			sessionManager: {
				getSessionId: () => sessionId,
				getCwd: () => process.cwd(),
			},
		} as never as ExtensionContext;
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const sessionBranch = handlers.get("session_branch") as never as (
			event: SessionBranchEvent,
			context: ExtensionContext,
		) => void;
		const messageStart = handlers.get("message_start") as never as (event: MessageStartEvent) => void;
		const agentEnd = handlers.get("agent_end") as never as (event: AgentEndEvent) => void;

		sessionStart({ type: "session_start" }, context);
		messageStart(userMessageStart("old prompt"));
		sessionId = "session-branched";
		write.mockClear();

		sessionBranch({ type: "session_branch", previousSessionFile: undefined }, context);
		agentEnd({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "orphan stop" }] } as never],
		});

		const bodies = parseBodies(write);
		expect(bodies).toEqual([
			expect.objectContaining({ event: "session_start", session_id: "session-branched", project }),
			expect.objectContaining({
				event: "stop",
				session_id: "session-branched",
				response: "orphan stop",
				project,
			}),
		]);
		expect(bodies[1]).not.toHaveProperty("query");
	});

	it("maps approval requests to Warp permission requests", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = createHandlers();
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		sessionStart({ type: "session_start" }, bridgeContext());
		write.mockClear();

		const approvalRequested = handlers.get("tool_approval_requested") as never as (
			event: ToolApprovalRequestedEvent,
		) => void;
		approvalRequested({
			type: "tool_approval_requested",
			sessionId: "session-123",
			toolCallId: "tool-call-123",
			toolName: "bash",
			approvalMode: "always-ask",
		});

		const osc = write.mock.calls[0]?.[0] as string;
		expect(osc.startsWith(OSC_PREFIX)).toBe(true);
		expect(osc.endsWith("\x07")).toBe(true);
		const body = JSON.parse(osc.slice(OSC_PREFIX.length, osc.length - 1));
		expect(body).toEqual({
			event: "permission_request",
			tool_name: "bash",
			summary: "omp wants to run bash",
			v: 1,
			agent: "omp",
			session_id: "session-123",
			cwd: process.cwd(),
			project,
			plugin_version: VERSION,
		});
	});
});
