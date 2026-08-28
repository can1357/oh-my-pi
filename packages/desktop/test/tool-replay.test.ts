import { describe, expect, test } from "bun:test";
import { collectToolCalls, messageText, TranscriptModel } from "../src/rpc/transcript";

/**
 * Shapes taken from a real session file, not from the docs — the difference
 * between them is the whole bug. A `toolResult` message carries no arguments;
 * they are on the assistant's `toolCall` block, under `arguments`, while the
 * live frame calls the same field `args`.
 *
 * Reopening a session built its cards from results alone, so every tool showed
 * `…` where its command should be.
 */
const HISTORY = [
	{ role: "user", content: [{ type: "text", text: "lista los ficheros" }] },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "voy a mirar" },
			{
				type: "toolCall",
				id: "toolu_01UwNZ7X",
				name: "bash",
				arguments: { command: "ls -la", i: "List the workspace" },
				intent: "List the workspace",
			},
		],
	},
	{
		role: "toolResult",
		toolCallId: "toolu_01UwNZ7X",
		toolName: "bash",
		content: [{ type: "text", text: "total 8" }],
		details: { exitCode: 0 },
		isError: false,
		timestamp: 1787408802204,
	},
];

describe("collectToolCalls", () => {
	test("finds arguments under `arguments`, which is where they are stored", () => {
		const calls = collectToolCalls(HISTORY);
		expect(calls.get("toolu_01UwNZ7X")?.args).toEqual({ command: "ls -la", i: "List the workspace" });
	});

	test("carries the intent, which is also only on the call", () => {
		expect(collectToolCalls(HISTORY).get("toolu_01UwNZ7X")?.intent).toBe("List the workspace");
	});

	test("ignores blocks that are not tool calls", () => {
		expect(collectToolCalls(HISTORY).size).toBe(1);
	});

	test("survives malformed history rather than throwing", () => {
		// Old sessions and partial writes both produce shapes like these.
		expect(collectToolCalls([null, 7, "x", { role: "assistant" }, { role: "assistant", content: "no" }]).size).toBe(
			0,
		);
		expect(collectToolCalls([{ role: "assistant", content: [{ type: "toolCall" }] }]).size).toBe(0);
	});
});

describe("a replayed tool card", () => {
	const model = new TranscriptModel();
	model.hydrate(HISTORY);
	const entries = model.entries;
	const tool = entries.find(e => e.kind === "tool");

	test("knows its command — the regression", () => {
		// `bash.tsx` renders "…" for its command when args.command is undefined,
		// which is exactly what a reopened session used to show.
		expect(tool).toBeDefined();
		expect((tool as { args?: { command?: string } }).args?.command).toBe("ls -la");
	});

	test("keeps its intent and its result", () => {
		expect((tool as { intent?: string }).intent).toBe("List the workspace");
		expect((tool as { result?: { details?: unknown } }).result?.details).toEqual({ exitCode: 0 });
	});

	test("renders the user turn and the assistant turn around it", () => {
		expect(entries.map(e => e.kind)).toEqual(["message", "message", "tool"]);
	});
});

/**
 * `reloadMessages` exists to be called while a turn is running: `get_messages`
 * is the one history command with no `session_busy` guard. But the server
 * appends an assistant message only at `message_end` and a tool only once its
 * `toolResult` lands, so the answer cannot contain what is still in flight —
 * and `hydrate` used to throw that away along with the handles the frames that
 * follow need.
 */
describe("a reload during a live turn", () => {
	const USER = { role: "user", content: [{ type: "text", text: "hola" }], timestamp: 1 };
	const streaming = (text: string, final = false) => ({
		type: final ? "message_end" : "message_update",
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2 },
	});

	test("keeps the reply being written, and finishes it in place", () => {
		const model = new TranscriptModel();
		model.apply({ type: "message_start", message: USER });
		model.apply(streaming("Ho"));

		// What `get_messages` answers mid-stream: the prompt, and nothing else.
		model.hydrate([USER]);
		expect(model.entries.map(e => e.kind)).toEqual(["message", "message"]);
		const open = model.entries[1];
		if (open.kind !== "message") throw new Error("expected a message");
		expect(open.streaming).toBe(true);

		model.apply(streaming("Hola qué tal", true));
		expect(model.entries).toHaveLength(2);
		const done = model.entries[1];
		if (done.kind !== "message") throw new Error("expected a message");
		expect(messageText(done.content)).toBe("Hola qué tal");
		expect(done.streaming).toBe(false);
	});

	test("does not open a second bubble when the reload already carried the reply", () => {
		const model = new TranscriptModel();
		model.apply({ type: "message_start", message: USER });
		model.apply(streaming("Hola"));

		// The same message, this time inside the answer — the reload landed after
		// `message_end` appended it server-side.
		model.hydrate([USER, { role: "assistant", content: [{ type: "text", text: "Hola" }], timestamp: 2 }]);
		model.apply(streaming("Hola qué tal", true));

		expect(model.entries.filter(e => e.kind === "message" && e.role === "assistant")).toHaveLength(1);
	});

	test("keeps a running tool card, and its result still lands on it", () => {
		const model = new TranscriptModel();
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
			timestamp: 2,
		};
		model.apply({ type: "message_start", message: USER });
		model.apply({ type: "message_end", message: call });
		model.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });

		// No `toolResult` yet, so the answer stops at the call that asked for it.
		model.hydrate([USER, call]);
		expect(model.entries.map(e => e.kind)).toEqual(["message", "message", "tool"]);

		expect(model.apply({ type: "tool_execution_end", toolCallId: "t1", result: { ok: 1 }, isError: false })).toBe(
			true,
		);
		const tool = model.entries[2];
		if (tool.kind !== "tool") throw new Error("expected a tool");
		expect(tool.running).toBe(false);
		expect(tool.result).toEqual({ ok: 1 });
	});

	test("does not draw the card twice when the reload already carried the result", () => {
		const model = new TranscriptModel();
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
			timestamp: 2,
		};
		model.apply({ type: "message_end", message: call });
		model.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });

		model.hydrate([
			call,
			{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false, timestamp: 3 },
		]);

		const tools = model.entries.filter(e => e.kind === "tool");
		expect(tools).toHaveLength(1);
		expect((tools[0] as { running: boolean }).running).toBe(false);
	});
});
