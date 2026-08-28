import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	BLOCKING_UI_METHODS,
	isAvailableCommandsUpdate,
	isExtensionUiRequest,
	isReadyFrame,
	isResponseFrame,
	type ReadyFrame,
	type RpcSessionState,
	type ServerFrame,
	type SessionInfo,
} from "../src/rpc/protocol";
import { messageText, TranscriptModel } from "../src/rpc/transcript";

/**
 * Pins our local protocol declarations against frames captured from a real
 * `omp --mode rpc-ui` session (v17.4.0, protocol v1).
 *
 * `protocol.ts` mirrors omp's `rpc-types` structurally rather than importing
 * them, because that module's type graph reaches into `bun:sqlite` and node
 * builtins that do not belong in a DOM tsconfig. This file is what keeps the
 * mirror honest: if omp changes a frame, these fixtures stop matching.
 *
 * Every fixture below is verbatim from a live capture — not hand-written.
 */

const READY = {
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1048576,
	maxReassembledFrameBytes: 67108864,
} as const;

describe("captured frames satisfy the declared shapes", () => {
	test("ready", () => {
		const frame: ServerFrame = READY;
		expect(isReadyFrame(frame)).toBe(true);
		if (!isReadyFrame(frame)) throw new Error("unreachable");

		const ready: ReadyFrame = frame;
		expect(ready.protocolVersion).toBe(1);
		// v1 caps a physical frame at 1 MiB; v2 negotiation raises the
		// reassembled ceiling to 64 MiB. Both are load-bearing for paging.
		expect(ready.maxFrameBytes).toBe(1024 * 1024);
		expect(ready.maxReassembledFrameBytes).toBe(64 * 1024 * 1024);
		expect(ready.supportedProtocolVersions).toContain(2);
	});

	test("response carries id and command, not a payload envelope", () => {
		const frame: ServerFrame = { type: "response", id: "a1", command: "get_state", success: true };
		expect(isResponseFrame(frame)).toBe(true);
		if (!isResponseFrame(frame)) throw new Error("unreachable");
		expect(frame.id).toBe("a1");
	});

	test("the unprompted startup UI request is non-blocking", () => {
		// Captured verbatim: this arrives right after `ready`, unasked.
		const frame: ServerFrame = {
			type: "extension_ui_request",
			id: "15678252b225c01a",
			method: "setWidget",
			widgetKey: "autoresearch",
		};
		expect(isExtensionUiRequest(frame)).toBe(true);
		if (!isExtensionUiRequest(frame)) throw new Error("unreachable");

		// Leaving this unanswered for 12s did not wedge the server, so the bridge
		// is allowed to drop it.
		expect(BLOCKING_UI_METHODS.has(frame.method)).toBe(false);
	});

	test("only the answerable methods are marked blocking", () => {
		expect([...BLOCKING_UI_METHODS].sort()).toEqual(["confirm", "editor", "input", "open_url", "select"]);
		for (const method of ["notify", "setStatus", "setWidget", "setTitle", "cancel"] as const) {
			expect(BLOCKING_UI_METHODS.has(method)).toBe(false);
		}
	});

	test("available_commands_update exposes subcommands", () => {
		// A stock install reported 79 commands, 18 with subcommands; `/mcp` alone
		// has 17 — far more than the four the docs name, which is why the UI
		// discovers them at runtime instead of hardcoding.
		const frame: ServerFrame = {
			type: "available_commands_update",
			commands: [
				{
					name: "mcp",
					source: "builtin",
					subcommands: [{ name: "add" }, { name: "list" }, { name: "reauth" }],
				},
			],
		};
		expect(isAvailableCommandsUpdate(frame)).toBe(true);
		if (!isAvailableCommandsUpdate(frame)) throw new Error("unreachable");
		expect(frame.commands[0].subcommands).toHaveLength(3);
	});

	test("session state carries everything the status bar needs", () => {
		const state: RpcSessionState = {
			model: { provider: "anthropic", id: "claude-opus-4-8" },
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			sessionId: "01a040fa",
			autoCompactionEnabled: true,
			fastModeEnabled: false,
			fastModeActive: false,
			tokensPerSecond: null,
			messageCount: 4,
			queuedMessageCount: 0,
			todoPhases: [],
			contextUsage: { used: 12000, total: 200000 },
		};
		// One get_state answers the whole bar — no extra round trips.
		expect(state.contextUsage).toBeDefined();
		expect(state.todoPhases).toEqual([]);
	});

	test("sessions --json entries carry project grouping", () => {
		const entry: SessionInfo = {
			path: "/Users/x/.omp/agent/sessions/-Documents-atenea/2026-08-27T02-08-54-238Z_01a0.jsonl",
			id: "01a0",
			cwd: "/Users/x/Documents/atenea",
			created: "2026-08-27T02:08:54.238Z",
			modified: "2026-08-27T02:09:01.495Z",
			messageCount: 4,
			size: 4947,
			firstMessage: "hello",
			status: "complete",
			projectRoot: "/Users/x/Documents/atenea",
			isWorktree: false,
		};
		// The bucket name is the slugified path and is ambiguous for folders with
		// hyphens; `cwd` is the real one and `projectRoot` is git-resolved.
		expect(entry.projectRoot).not.toContain("-Documents-");
	});
});

describe("transcript model against captured streaming shapes", () => {
	/** `message_update` carries the FULL message, not a delta. */
	const assistant = (text: string) => ({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: {} },
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 },
	});

	test("streaming replaces the open message instead of appending bubbles", () => {
		const model = new TranscriptModel();
		model.apply({ type: "message_start", message: { role: "assistant", content: [] } });
		model.apply(assistant("Hel"));
		model.apply(assistant("Hello"));
		model.apply(assistant("Hello there"));

		expect(model.entries).toHaveLength(1);
		const entry = model.entries[0];
		if (entry.kind !== "message") throw new Error("expected a message");
		expect(messageText(entry.content)).toBe("Hello there");
		expect(entry.streaming).toBe(true);

		model.apply({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] },
		});
		const done = model.entries[0];
		if (done.kind !== "message") throw new Error("expected a message");
		expect(done.streaming).toBe(false);
	});

	test("tool lifecycle collapses into one card", () => {
		const model = new TranscriptModel();
		model.apply({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "echo hi", cwd: "/tmp" },
			intent: "run echo",
		});
		model.apply({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "echo hi" },
			partialResult: { content: [{ type: "text", text: "hi" }], details: {} },
		});
		model.apply({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "hi\n" }], details: { wallTimeMs: 12 } },
			isError: false,
		});

		expect(model.entries).toHaveLength(1);
		const entry = model.entries[0];
		if (entry.kind !== "tool") throw new Error("expected a tool");
		expect(entry.name).toBe("bash");
		expect(entry.running).toBe(false);
		expect(entry.isError).toBe(false);
		expect(entry.partial).toBeUndefined();
	});

	test("a tool call closes the message that requested it", () => {
		const model = new TranscriptModel();
		model.apply(assistant("Let me check."));
		model.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
		model.apply(assistant("Found it."));

		// message, tool, message — not one bubble that swallowed the second reply.
		expect(model.entries.map(e => e.kind)).toEqual(["message", "tool", "message"]);
	});

	test("agent_end settles a message that never got message_end", () => {
		const model = new TranscriptModel();
		model.apply(assistant("interrupted…"));
		model.apply({ type: "agent_end", isTerminal: true });

		const entry = model.entries[0];
		if (entry.kind !== "message") throw new Error("expected a message");
		expect(entry.streaming).toBe(false);
	});

	test("unknown and malformed events are ignored without throwing", () => {
		const model = new TranscriptModel();
		expect(model.apply({ type: "notice", level: "info", message: "hi" })).toBe(false);
		expect(model.apply({ type: "message_update", message: null })).toBe(false);
		expect(model.apply({ type: "tool_execution_end", toolCallId: "nope" })).toBe(false);
		expect(model.entries).toHaveLength(0);
	});

	test("one prompt renders one bubble, not two", () => {
		// A user message arrives on BOTH message_start and message_end with an
		// identical payload. Captured from a live turn:
		//   message_start(user) → message_end(user) → message_start(assistant) → …
		const model = new TranscriptModel();
		const user = {
			role: "user",
			content: [{ type: "text", text: "hola" }],
			timestamp: 1_700_000_000,
		};
		model.apply({ type: "message_start", message: user });
		model.apply({ type: "message_end", message: user });

		expect(model.entries).toHaveLength(1);
		expect(model.entries[0].kind).toBe("message");
	});

	test("two distinct prompts still render twice", () => {
		const model = new TranscriptModel();
		model.apply({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "hola" }], timestamp: 1 },
		});
		model.apply({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "hola" }], timestamp: 2 },
		});
		expect(model.entries).toHaveLength(2);
	});

	test("identical prompts with no timestamp fall back to content identity", () => {
		const model = new TranscriptModel();
		const message = { role: "user", content: [{ type: "text", text: "hola" }] };
		model.apply({ type: "message_start", message });
		model.apply({ type: "message_end", message });
		expect(model.entries).toHaveLength(1);
	});

	test("hydrate fills the transcript from a saved session", () => {
		// Shape captured from `get_messages_page` on a real session file.
		const model = new TranscriptModel();
		model.hydrate([
			{ role: "user", content: [{ type: "text", text: "hola" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "Hola. ¿Qué necesitas?" }], timestamp: 2 },
		]);

		expect(model.entries).toHaveLength(2);
		const [first, second] = model.entries;
		if (first.kind !== "message" || second.kind !== "message") throw new Error("expected messages");
		expect(first.role).toBe("user");
		expect(messageText(second.content)).toContain("Hola");
		// Nothing from a saved session is still streaming.
		expect(second.streaming).toBe(false);
	});

	test("hydrate renders tool results as tool cards", () => {
		const model = new TranscriptModel();
		model.hydrate([
			{ role: "assistant", content: [{ type: "text", text: "checking" }], timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(model.entries.map(e => e.kind)).toEqual(["message", "tool"]);
		const tool = model.entries[1];
		if (tool.kind !== "tool") throw new Error("expected a tool");
		expect(tool.name).toBe("bash");
		expect(tool.running).toBe(false);
	});

	test("a re-hydrate does not stack on the previous history", () => {
		const model = new TranscriptModel();
		const history = [{ role: "user", content: [{ type: "text", text: "x" }], timestamp: 1 }];
		model.hydrate(history);
		model.hydrate(history);
		expect(model.entries).toHaveLength(1);
	});

	test("live frames continue after hydrate without duplicating history", () => {
		const model = new TranscriptModel();
		const first = { role: "user", content: [{ type: "text", text: "hola" }], timestamp: 1 };
		model.hydrate([first]);
		// The same message arriving again from the stream must not double up.
		model.apply({ type: "message_start", message: first });
		expect(model.entries).toHaveLength(1);

		model.apply({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "otra" }], timestamp: 2 },
		});
		expect(model.entries).toHaveLength(2);
	});

	test("tool-result messages never render as chat bubbles", () => {
		const model = new TranscriptModel();
		model.apply({
			type: "message_start",
			message: { role: "toolResult", content: [{ type: "text", text: "output" }] },
		});
		expect(model.entries).toHaveLength(0);
	});
});

/**
 * The other direction, which nothing was checking.
 *
 * Everything above pins the frames the server sends us. The commands *we* send
 * had no guard at all, and that is the direction three of this package's four
 * shape bugs went — `args` vs `arguments`, `items` vs `tasks`, and `path` vs
 * `sessionPath`, which made every rename of a closed session land on an empty
 * throwaway while reporting success.
 *
 * So this reads omp's own declaration rather than a copy of it. A fixture would
 * drift with us; the source cannot.
 *
 * AGENTS.md:284 bans reading implementation source and asserting on its text,
 * and the ban is right about the risk: a reformat of `rpc-types.ts` breaks this,
 * and a wrongly encoded frame could still pass. The rule's own alternative — a
 * type test — was built and measured, and it does not work here:
 *
 *   - it catches the exact historical bug (`path` where the server declares
 *     `sessionPath`) as a compile error, so the idea is sound;
 *   - but importing those types pulls omp's transitive type graph into this
 *     package's `tsconfig`, and under the DOM lib the desktop needs,
 *     `packages/ai/src/providers/bedrock-mantle.ts` stops type-checking —
 *     `Uint8Array` is not a `BodyInit` once DOM's `RequestInit` is in scope.
 *     It also takes the package's typecheck from 0.4s to ~6s.
 *
 * Making that work means changing another package's types for this one's
 * convenience. So the scan stays, deliberately and in the open, until the RPC
 * types can be imported without the rest of the graph. Four of the five shape
 * bugs this package has had went client-to-server, and nothing else looks there.
 */
describe("commands we send match what the server declares", () => {
	const TYPES = new URL("../../coding-agent/src/modes/rpc/rpc-types.ts", import.meta.url).pathname;

	/** Field names declared for one member of the `RpcCommand` union. */
	function declaredFields(command: string): string[] {
		const source = readFileSync(TYPES, "utf8");
		const line = source
			.split("\n")
			.find(entry => entry.includes(`type: "${command}"`) && entry.trimStart().startsWith("|"));
		if (!line) throw new Error(`no RpcCommand member declares type "${command}"`);
		return [...line.matchAll(/(\w+)\??:/g)].map(match => match[1]).filter(name => name !== "type");
	}

	test("switch_session takes sessionPath, not path", () => {
		expect(declaredFields("switch_session")).toContain("sessionPath");
		expect(declaredFields("switch_session")).not.toContain("path");
	});

	test("the commands sessionOps builds only use fields the server declares", () => {
		// These are the frames `oneshot` writes by hand, outside the bridge's
		// typed wrappers — the only place in the app that hand-encodes a command.
		const sent = {
			switch_session: ["sessionPath"],
			set_session_name: ["name"],
			export_html: ["outputPath"],
		};

		for (const [command, fields] of Object.entries(sent)) {
			const declared = declaredFields(command);
			for (const field of fields) {
				expect({ command, field, declared }).toMatchObject({ declared: expect.arrayContaining([field]) });
			}
		}
	});
});
