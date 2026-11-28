import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { PanelEvent, RpcSessionInfo } from "../extension/messages";
import type { PanelSnapshot, PanelWorker } from "../extension/panel/session";
import { RpcPanelSession } from "../extension/panel/sessions/rpc";

const INFO: RpcSessionInfo = { sessionKey: "s1", cwd: "/work/site", title: "", startedAt: 0, tabIds: [7] };

interface SentCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

/** A worker whose `rpcSend` records commands and whose rpc lines the test pushes. */
class FakeWorker implements PanelWorker {
	readonly sent: SentCommand[] = [];
	readonly closed: string[] = [];
	readonly #listeners = new Set<(event: PanelEvent) => void>();
	readonly #sendWaiters: { type: string; resolve: () => void }[] = [];

	request: PanelWorker["request"] = async (op, fields) => {
		if (op === "rpcSend" && "line" in fields && typeof fields.line === "string") {
			const command: SentCommand = JSON.parse(fields.line);
			this.sent.push(command);
			for (const waiter of this.#sendWaiters.splice(0)) {
				if (waiter.type === command.type) waiter.resolve();
				else this.#sendWaiters.push(waiter);
			}
		}
		if (op === "rpcClose" && "sessionKey" in fields) this.closed.push(String(fields.sessionKey));
		return undefined as never;
	};

	onEvent(listener: (event: PanelEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(event: PanelEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	line(frame: object, sessionKey = INFO.sessionKey): void {
		this.emit({ event: "rpcLine", sessionKey, line: JSON.stringify(frame) });
	}

	/** Resolves when the next command of `type` is sent. */
	nextSend(type: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#sendWaiters.push({ type, resolve });
		return promise;
	}

	/** The latest command of `type` not yet answered. */
	last(type: string): SentCommand {
		const command = this.sent.findLast(candidate => candidate.type === type);
		if (!command) throw new Error(`no ${type} command sent; sent: ${this.sent.map(c => c.type).join(", ")}`);
		return command;
	}

	respond(type: string, data?: unknown): void {
		const command = this.last(type);
		this.line({ id: command.id, type: "response", command: type, success: true, data });
	}
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 2,
	};
}

const USER_ENTRY: SessionEntry = {
	type: "message",
	id: "e1",
	parentId: null,
	timestamp: "2026-11-20T10:00:00Z",
	message: { role: "user", content: "summarize this page", timestamp: 1 },
};

const STATE = {
	sessionId: "sess-1",
	sessionName: "demo",
	isStreaming: false,
	queuedMessageCount: 0,
	thinkingLevel: "high",
	model: { id: "m1", name: "Model One", provider: "acme", contextWindow: 200_000 },
	contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
	systemPrompt: ["huge"],
	dumpTools: [],
};

/** Resolves once a published snapshot satisfies `predicate`. */
function until(session: RpcPanelSession, predicate: (snapshot: PanelSnapshot) => boolean): Promise<void> {
	if (predicate(session.getSnapshot())) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(() => {
		if (!predicate(session.getSnapshot())) return;
		unsubscribe();
		resolve();
	});
	return promise;
}

/** Opens a session and completes its attach: state plus a transcript holding one user turn. */
async function attached(): Promise<{ worker: FakeWorker; session: RpcPanelSession }> {
	const worker = new FakeWorker();
	const session = new RpcPanelSession(worker, INFO);
	expect(session.getSnapshot().phase).toBe("connecting");
	expect(worker.sent.map(command => command.type)).toEqual(["set_subagent_subscription", "get_state", "get_entries"]);
	expect(worker.last("get_entries").since).toBeUndefined();
	worker.respond("get_state", STATE);
	// A non-rendered entry type still moves the cursor.
	worker.respond("get_entries", { entries: [USER_ENTRY, { type: "label", id: "e2", parentId: "e1" }], leafId: "e2" });
	await until(session, snapshot => snapshot.phase === "live");
	return { worker, session };
}

describe("rpc panel session", () => {
	it("rebuilds the transcript and state of a session it attaches to", async () => {
		const { session } = await attached();
		const snapshot = session.getSnapshot();
		expect(snapshot.phase).toBe("live");
		expect(snapshot.entries).toEqual([USER_ENTRY]);
		expect(snapshot.header).toMatchObject({ type: "session", id: "sess-1", title: "demo", cwd: "/work/site" });
		expect(snapshot.state).toEqual({
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "demo",
			cwd: "/work/site",
			model: { id: "m1", name: "Model One", provider: "acme", contextWindow: 200_000 },
			thinkingLevel: "high",
			contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
			participants: [],
		});
		expect(session.title).toBe("demo");
	});

	it("projects a streamed turn: text, tool start/update/end, committed rows and the run's end", async () => {
		const { worker, session } = await attached();
		worker.line({ type: "agent_start" });
		expect(session.getSnapshot().working).toBe(true);

		worker.line({ type: "message_start", messageId: "msg-1", message: assistant("") });
		worker.line({
			type: "message_update",
			messageId: "msg-1",
			message: assistant("Hel"),
			assistantMessageEvent: { type: "text_delta" },
		});
		worker.line({
			type: "message_update",
			messageId: "msg-1",
			message: assistant("Hello"),
			assistantMessageEvent: { type: "text_delta" },
		});
		// Streaming updates publish once per frame.
		expect(session.getSnapshot().stream).toEqual(assistant(""));
		await until(session, snapshot => JSON.stringify(snapshot.stream) === JSON.stringify(assistant("Hello")));
		expect(session.getSnapshot().stream).toEqual(assistant("Hello"));
		expect(session.getSnapshot().streamDone).toBe(false);

		worker.line({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "browser",
			args: { op: "click" },
			intent: "Clicking",
		});
		worker.line({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "browser",
			args: { op: "click" },
			partialResult: { content: [{ type: "text", text: "half" }] },
		});
		await until(session, snapshot => snapshot.activeTools.get("t1")?.partialResult !== undefined);
		expect(session.getSnapshot().activeTools.get("t1")).toMatchObject({
			toolName: "browser",
			args: { op: "click" },
			intent: "Clicking",
			partialResult: { content: [{ type: "text", text: "half" }] },
		});
		worker.line({ type: "tool_execution_end", toolCallId: "t1", toolName: "browser", result: {} });
		expect(session.getSnapshot().activeTools.size).toBe(0);

		worker.line({ type: "message_end", messageId: "msg-1", message: assistant("Hello there") });
		expect(session.getSnapshot()).toMatchObject({ stream: assistant("Hello there"), streamDone: true });
		// The finished message is fetched from the session after the last entry seen.
		expect(worker.last("get_entries").since).toBe("e2");
		const assistantEntry: SessionEntry = {
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-11-20T10:00:05Z",
			message: assistant("Hello there"),
		};
		worker.respond("get_entries", { entries: [assistantEntry], leafId: "e3" });
		await until(session, snapshot => snapshot.entries.length === 2);
		expect(session.getSnapshot().entries).toEqual([USER_ENTRY, assistantEntry]);
		// The committed row replaces the stream ghost.
		expect(session.getSnapshot().stream).toBeNull();

		worker.line({ type: "agent_end", messages: [], isTerminal: false, yielded: false });
		expect(session.getSnapshot().working).toBe(true);
		worker.line({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
		expect(session.getSnapshot().working).toBe(false);
		expect(session.getSnapshot().state?.isStreaming).toBe(false);
	});

	it("ignores other sessions' lines and coalesces entry refreshes", async () => {
		const { worker, session } = await attached();
		worker.line({ type: "agent_start" }, "other");
		expect(session.getSnapshot().working).toBe(false);

		const before = worker.sent.filter(command => command.type === "get_entries").length;
		worker.line({ type: "message_end", message: { role: "user", content: "a", timestamp: 1 } });
		worker.line({
			type: "message_end",
			message: { role: "toolResult", toolCallId: "x", toolName: "y", content: [], isError: false, timestamp: 1 },
		});
		// One fetch in flight; the second request waits for it.
		expect(worker.sent.filter(command => command.type === "get_entries").length).toBe(before + 1);
		const second = worker.nextSend("get_entries");
		worker.respond("get_entries", { entries: [], leafId: "e2" });
		await second;
		expect(worker.last("get_entries").since).toBe("e2");
	});

	// The panel keeps the entries of earlier reads: an elide pass's record that a later read returns must reach
	// them, or the panel shows the text the pass removed for the life of the view. That read's own entries already
	// carry its records, which may predate a later rewrite of the entry (docs/rpc.md).
	it("sets the fields a later read's record names on the entries of earlier reads, and not on that read's", async () => {
		const { worker, session } = await attached();
		worker.line({ type: "message_end", messageId: "msg-1", message: assistant("current reply") });
		expect(worker.last("get_entries").since).toBe("e2");
		const reply: SessionEntry = {
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-11-20T10:00:05Z",
			message: assistant("current reply"),
		};
		const record = (id: string, entryId: string, content: unknown) => ({
			type: "custom",
			customType: "entry_patch",
			id,
			parentId: "e3",
			timestamp: "2026-11-20T10:00:06Z",
			data: { patches: [{ entryId, message: { content } }] },
		});
		worker.respond("get_entries", {
			entries: [
				reply,
				record("p1", "e1", "[elided prompt]"),
				record("p2", "e3", [{ type: "text", text: "older reply" }]),
			],
			leafId: "p2",
		});
		await until(session, snapshot => snapshot.entries.length === 2);
		expect(session.getSnapshot().entries).toEqual([
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-11-20T10:00:00Z",
				message: { role: "user", content: "[elided prompt]", timestamp: 1 },
			},
			reply,
		]);
	});

	it("forwards prompts with images, answers dialogs and acknowledges stop", async () => {
		const { worker, session } = await attached();
		const image = { type: "image" as const, data: "iVBORw0K", mimeType: "image/png" };
		session.prompt("what is this?", [image]);
		expect(worker.last("prompt")).toMatchObject({
			message: "what is this?",
			images: [image],
			streamingBehavior: "steer",
		});

		worker.line({
			type: "extension_ui_request",
			id: "ui-1",
			method: "select",
			title: "Pick one",
			options: ["A", "B"],
			optionDetails: [{}, { description: "second" }],
		});
		worker.line({
			type: "extension_ui_request",
			id: "ui-2",
			method: "confirm",
			title: "Proceed?",
			message: "It deletes files",
		});
		const select = session.getSnapshot().uiRequest;
		expect(select).toMatchObject({
			kind: "select",
			title: "Pick one",
			options: ["A", { label: "B", description: "second" }],
		});
		session.answer(select?.reqId ?? -1, "B");
		const confirm = session.getSnapshot().uiRequest;
		expect(confirm).toMatchObject({
			kind: "select",
			title: "Proceed?",
			helpText: "It deletes files",
			options: ["Yes", "No"],
		});
		session.answer(confirm?.reqId ?? -1, "Yes");
		expect(session.getSnapshot().uiRequest).toBeNull();
		const responses = worker.sent.filter(command => command.type === "extension_ui_response");
		expect(responses).toEqual([
			{ type: "extension_ui_response", id: "ui-1", value: "B" },
			{ type: "extension_ui_response", id: "ui-2", confirmed: true },
		]);

		// A dialog the agent withdraws disappears.
		worker.line({ type: "extension_ui_request", id: "ui-3", method: "editor", title: "Edit", prefill: "x" });
		expect(session.getSnapshot().uiRequest).toMatchObject({ kind: "editor", prefill: "x" });
		worker.line({ type: "extension_ui_request", id: "ui-4", method: "cancel", targetId: "ui-3" });
		expect(session.getSnapshot().uiRequest).toBeNull();

		// The panel cannot render an HTML form, so it cancels one instead of leaving the caller waiting.
		worker.line({ type: "extension_ui_request", id: "ui-5", method: "form", html: "<form></form>" });
		expect(session.getSnapshot().uiRequest).toBeNull();
		expect(worker.sent.filter(command => command.type === "extension_ui_response").at(-1)).toEqual({
			type: "extension_ui_response",
			id: "ui-5",
			cancelled: true,
		});

		// Stop is omp's Esc: the queue comes back, steering before follow-ups, instead of running later.
		let stopped = false;
		const stop = session.abort().then(drafts => {
			stopped = true;
			return drafts;
		});
		expect(session.getSnapshot().state?.isAborting).toBe(true);
		expect(stopped).toBe(false);
		worker.respond("abort_and_restore_queue", {
			steering: [{ text: "fix the header" }],
			followUp: [{ text: "then deploy", images: [image] }],
		});
		expect(await stop).toEqual([
			{ text: "fix the header", images: [] },
			{ text: "then deploy", images: [image] },
		]);
		expect(session.getSnapshot().state?.isAborting).toBeUndefined();
	});

	it("emits the collab compaction notices and lists and switches models", async () => {
		const { worker, session } = await attached();
		worker.line({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		worker.line({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: false });
		expect(session.getSnapshot().notices.map(notice => notice.message)).toEqual([
			"compacting context (threshold)",
			"context compacted",
		]);

		const models = session.listModels?.();
		worker.respond("get_available_models", {
			models: [{ id: "m2", name: "Model Two", provider: "acme", contextWindow: null }],
		});
		expect(await models).toEqual([{ provider: "acme", id: "m2", name: "Model Two" }]);
		const switched = session.setModel?.({ provider: "acme", id: "m2", name: "Model Two" });
		expect(worker.last("set_model")).toMatchObject({ provider: "acme", modelId: "m2" });
		worker.respond("set_model", {});
		await switched;
		expect(worker.last("get_state")).toBeDefined();
	});

	it("detaches without stopping the process: no rpcClose, no further updates", async () => {
		const { worker, session } = await attached();
		let published = 0;
		session.subscribe(() => published++);
		const models = session.listModels?.();
		session.detach();
		await expect(models).rejects.toThrow("the panel left this session");

		const before = session.getSnapshot();
		worker.line({ type: "agent_start" });
		worker.line({ type: "notice", level: "info", message: "still running" });
		expect(session.getSnapshot()).toBe(before);
		expect(published).toBe(0);
		expect(worker.closed).toEqual([]);
		expect(worker.sent.some(command => command.type === "abort_and_restore_queue")).toBe(false);
	});

	it("ends when the worker reports the process exited, failing pending calls", async () => {
		const { worker, session } = await attached();
		const models = session.listModels?.();
		worker.emit({
			event: "rpcSessions",
			sessions: [{ ...INFO, exited: { code: 1, stderr: "boom\nfatal: no provider\n" } }],
		});
		expect(session.getSnapshot()).toMatchObject({ phase: "ended", working: false });
		expect(session.getSnapshot().endedReason).toBe("omp exited with code 1: boom\nfatal: no provider");
		await expect(models).rejects.toThrow("omp exited with code 1");
		await expect(session.abort()).rejects.toThrow("omp exited");

		session.close();
		expect(worker.closed).toEqual(["s1"]);
	});
});
