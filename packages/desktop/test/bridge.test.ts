import { describe, expect, test } from "bun:test";
import { RpcBridge } from "../src/rpc/bridge";
import type { AgentHandle, PoolStatus, RelayEvent, Transport } from "../src/rpc/transport";

/**
 * Scriptable stand-in for the Rust relay. Captures what the bridge writes and
 * lets a test push frames back at whatever time and order it likes.
 */
class MockTransport implements Transport {
	sent: string[] = [];
	killed: string[] = [];
	suspended: string[] = [];
	#emit: ((event: RelayEvent) => void) | null = null;
	#tabId = "";

	async start(tabId: string, onEvent: (event: RelayEvent) => void): Promise<AgentHandle> {
		this.#tabId = tabId;
		this.#emit = onEvent;
		return { pid: 4242, resumed: false, prewarmed: false };
	}

	async send(_tabId: string, line: string): Promise<void> {
		this.sent.push(line);
	}

	async suspend(tabId: string): Promise<void> {
		this.suspended.push(tabId);
	}

	async kill(tabId: string): Promise<void> {
		this.killed.push(tabId);
	}

	async poolStatus(): Promise<PoolStatus> {
		return { live: 1, maxLive: 3, prewarmReady: true, tabs: [this.#tabId] };
	}

	// -- test helpers --

	/** Push raw stdout lines, exactly as the relay batches them. */
	lines(...lines: string[]): void {
		this.#emit?.({ event: "frames", data: { tabId: this.#tabId, lines } });
	}

	frames(...frames: object[]): void {
		this.lines(...frames.map(f => JSON.stringify(f)));
	}

	stderr(...lines: string[]): void {
		this.#emit?.({ event: "stderr", data: { tabId: this.#tabId, lines } });
	}

	exit(code: number | null = 1, signal: number | null = null): void {
		this.#emit?.({ event: "exited", data: { tabId: this.#tabId, code, signal } });
	}

	fault(message: string): void {
		this.#emit?.({ event: "fault", data: { tabId: this.#tabId, message } });
	}

	/** The pool reclaiming this session's slot. Routine, not a crash. */
	evict(): void {
		this.#emit?.({ event: "evicted", data: { tabId: this.#tabId } });
	}

	/** The `id` the bridge minted for the Nth command it sent. */
	idOf(index: number): string {
		return JSON.parse(this.sent[index]).id;
	}

	typeOf(index: number): string {
		return JSON.parse(this.sent[index]).type;
	}
}

async function connected(options?: ConstructorParameters<typeof RpcBridge>[2]) {
	const transport = new MockTransport();
	const bridge = new RpcBridge("tab-1", transport, options);
	await bridge.start();
	transport.frames({ type: "ready", protocolVersion: 1, maxFrameBytes: 1048576 });
	return { transport, bridge };
}

/** Let queued microtasks (snapshot notifications) run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("RpcBridge — correlation", () => {
	test("matches responses by id, not arrival order", async () => {
		const { transport, bridge } = await connected();

		const first = bridge.request<{ tag: string }>({ type: "get_state" });
		const second = bridge.request<{ tag: string }>({ type: "get_session_stats" });
		const third = bridge.request<{ tag: string }>({ type: "get_available_commands" });
		await settle();

		const [id1, id2, id3] = [transport.idOf(0), transport.idOf(1), transport.idOf(2)];
		expect(new Set([id1, id2, id3]).size).toBe(3);

		// Answer in reverse order — the protocol explicitly permits this.
		transport.frames(
			{ type: "response", id: id3, data: { tag: "third" } },
			{ type: "response", id: id1, data: { tag: "first" } },
			{ type: "response", id: id2, data: { tag: "second" } },
		);

		expect(await first).toEqual({ tag: "first" });
		expect(await second).toEqual({ tag: "second" });
		expect(await third).toEqual({ tag: "third" });
	});

	test("a response for an unknown id is ignored, not thrown", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_state" });
		await settle();

		transport.frames({ type: "response", id: "not-ours", data: { nope: true } });
		transport.frames({ type: "response", id: transport.idOf(0), data: { ok: true } });

		expect(await pending).toEqual({ ok: true });
	});

	test("ids are never reused, so a late response cannot resolve a newer request", async () => {
		const { transport, bridge } = await connected();

		const first = bridge.request({ type: "get_state" }, 20);
		await settle();
		const staleId = transport.idOf(0);
		await expect(first).rejects.toThrow(/timed out/);

		const second = bridge.request<{ which: string }>({ type: "get_state" });
		await settle();
		expect(transport.idOf(1)).not.toBe(staleId);

		// The late response to the abandoned request must not settle the new one.
		transport.frames({ type: "response", id: staleId, data: { which: "stale" } });
		transport.frames({ type: "response", id: transport.idOf(1), data: { which: "fresh" } });

		expect(await second).toEqual({ which: "fresh" });
	});

	test("surfaces error responses with their machine-readable code", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_messages_page" });
		await settle();

		transport.frames({
			type: "response",
			id: transport.idOf(0),
			success: false,
			error: "session is streaming",
			code: "session_busy",
		});

		await expect(pending).rejects.toMatchObject({
			message: "session is streaming",
			code: "session_busy",
		});
	});
});

describe("RpcBridge — resilience", () => {
	test("a malformed line does not stop the stream", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_state" });
		await settle();

		transport.lines("{ this is not json", "", "   ");
		transport.frames({ type: "response", id: transport.idOf(0), data: { survived: true } });

		expect(await pending).toEqual({ survived: true });
		expect(bridge.getSnapshot().stderr.some(l => l.includes("unparseable"))).toBe(true);
	});

	test("a frame without a string type is skipped", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_state" });
		await settle();

		transport.frames({ notAType: 1 }, { type: 42 });
		transport.frames({ type: "response", id: transport.idOf(0), data: { ok: 1 } });

		expect(await pending).toEqual({ ok: 1 });
	});

	test("process death rejects everything in flight", async () => {
		const { transport, bridge } = await connected();
		const a = bridge.request({ type: "get_state" });
		const b = bridge.request({ type: "get_session_stats" });
		await settle();

		transport.exit(1, null);

		await expect(a).rejects.toThrow(/exited/);
		await expect(b).rejects.toThrow(/exited/);
		expect(bridge.getSnapshot().status).toBe("exited");
		expect(bridge.getSnapshot().exit).toEqual({ code: 1, signal: null });
	});

	test("a relay fault rejects in-flight requests and records the message", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_state" });
		await settle();

		transport.fault("sidecar not found");

		await expect(pending).rejects.toThrow(/sidecar not found/);
		expect(bridge.getSnapshot().status).toBe("error");
		expect(bridge.getSnapshot().error).toBe("sidecar not found");
	});
});

describe("RpcBridge — extension UI", () => {
	test("non-blocking requests never surface as a dialog", async () => {
		const notices: string[] = [];
		const { transport, bridge } = await connected({
			onNotice: request => notices.push(request.method),
		});

		transport.frames(
			{ type: "extension_ui_request", id: "u1", method: "setWidget", widgetKey: "autoresearch" },
			{ type: "extension_ui_request", id: "u2", method: "setStatus", message: "working" },
		);
		await settle();

		expect(bridge.getSnapshot().pendingUi).toBeNull();
		expect(notices).toEqual(["setWidget", "setStatus"]);
	});

	test("blocking requests surface and can be answered", async () => {
		const { transport, bridge } = await connected();

		transport.frames({
			type: "extension_ui_request",
			id: "u9",
			method: "confirm",
			title: "Confirm",
			message: "Run rm -rf?",
		});
		await settle();

		expect(bridge.getSnapshot().pendingUi?.id).toBe("u9");

		bridge.answerUi({ id: "u9", confirmed: false });
		await settle();

		expect(bridge.getSnapshot().pendingUi).toBeNull();
		const last = JSON.parse(transport.sent.at(-1)!);
		expect(last).toEqual({ type: "extension_ui_response", id: "u9", confirmed: false });
	});

	test("open_url is routed to the host instead of blocking", async () => {
		const opened: string[] = [];
		const { transport, bridge } = await connected({
			onOpenUrl: url => opened.push(url),
		});

		transport.frames({
			type: "extension_ui_request",
			id: "u3",
			method: "open_url",
			url: "https://example.test/oauth",
			launchUrl: "http://127.0.0.1:1/launch",
		});
		await settle();

		expect(opened).toEqual(["https://example.test/oauth"]);
		expect(bridge.getSnapshot().pendingUi).toBeNull();
	});
});

describe("RpcBridge — snapshots", () => {
	test("getSnapshot is referentially stable until something changes", async () => {
		const { transport, bridge } = await connected();
		await settle();

		const first = bridge.getSnapshot();
		expect(bridge.getSnapshot()).toBe(first); // same reference — no re-render

		transport.frames({ type: "notice", text: "hello" });
		await settle();

		const second = bridge.getSnapshot();
		expect(second).not.toBe(first);
		expect(second.events.length).toBe(1);
	});

	test("a burst of frames notifies subscribers once", async () => {
		const { transport, bridge } = await connected();
		await settle();

		let notifications = 0;
		bridge.subscribe(() => notifications++);

		transport.frames(
			{ type: "message_update", delta: "a" },
			{ type: "message_update", delta: "b" },
			{ type: "message_update", delta: "c" },
			{ type: "message_update", delta: "d" },
		);
		await settle();

		expect(bridge.getSnapshot().events.length).toBe(4);
		expect(notifications).toBe(1);
	});

	test("the ready frame lands in the snapshot", async () => {
		const { bridge } = await connected();
		await settle();

		const snapshot = bridge.getSnapshot();
		expect(snapshot.status).toBe("ready");
		expect(snapshot.ready?.protocolVersion).toBe(1);
		expect(snapshot.ready?.maxFrameBytes).toBe(1048576);
		expect(snapshot.pid).toBe(4242);
	});

	test("available_commands_update replaces the command list", async () => {
		const { transport, bridge } = await connected();

		transport.frames({
			type: "available_commands_update",
			commands: [
				{ name: "mcp", source: "builtin", subcommands: [{ name: "add" }, { name: "list" }] },
				{ name: "review", source: "builtin" },
			],
		});
		await settle();

		const { commands } = bridge.getSnapshot();
		expect(commands.map(c => c.name)).toEqual(["mcp", "review"]);
		expect(commands[0].subcommands).toHaveLength(2);
	});
});

describe("RpcBridge — lifecycle", () => {
	test("suspend kills the process and fails pending work", async () => {
		const { transport, bridge } = await connected();
		const pending = bridge.request({ type: "get_state" });
		await settle();

		await bridge.suspend();

		expect(transport.suspended).toEqual(["tab-1"]);
		await expect(pending).rejects.toThrow(/suspended/);
	});

	test("commands are written as one JSON line each", async () => {
		const { transport, bridge } = await connected();
		void bridge.prompt("hello");
		await settle();

		expect(transport.sent).toHaveLength(1);
		expect(transport.sent[0]).not.toContain("\n");
		expect(transport.typeOf(0)).toBe("prompt");
		expect(JSON.parse(transport.sent[0]).message).toBe("hello");
	});
});

/** A relay whose session is already up — what a reload or a remount sees. */
class ResumingTransport extends MockTransport {
	override async start(tabId: string, onEvent: (event: RelayEvent) => void): Promise<AgentHandle> {
		await super.start(tabId, onEvent);
		return { pid: 4242, resumed: true, prewarmed: false };
	}
}

/** A relay that cannot spawn at all — missing binary, bad cwd, poisoned mutex. */
class UnspawnableTransport extends MockTransport {
	override async start(): Promise<AgentHandle> {
		throw new Error("program not found");
	}
}

/**
 * The sidecar writes `ready` once, as it enters its protocol loop. A bridge that
 * attaches later — after a webview reload, a route change, or the `"scratch"`
 * tabId being handed between the session view and onboarding — will never see
 * it: the Rust relay replays buffered output only while the sink is still
 * unadopted, and re-adopting a live one replays nothing. Waiting for that frame
 * was a permanent "Starting the agent…".
 */
describe("RpcBridge — attaching to a session that is already up", () => {
	test("reaches ready on the first reply, with no second `ready` frame", async () => {
		const transport = new ResumingTransport();
		const bridge = new RpcBridge("tab-1", transport);
		await bridge.start();
		expect(bridge.getSnapshot().status).toBe("starting");

		const pending = bridge.request({ type: "get_state" });
		await settle();
		transport.frames({ type: "response", id: transport.idOf(0), data: { tag: "state" } });
		await pending;

		expect(bridge.getSnapshot().status).toBe("ready");
	});

	test("a failure reply counts too — it still came back from a live loop", async () => {
		const transport = new ResumingTransport();
		const bridge = new RpcBridge("tab-1", transport);
		await bridge.start();

		const pending = bridge.request({ type: "get_state" });
		await settle();
		transport.frames({ type: "response", id: transport.idOf(0), success: false, error: "session_busy" });
		await expect(pending).rejects.toThrow(/session_busy/);

		expect(bridge.getSnapshot().status).toBe("ready");
	});

	test("a rejected spawn reports the reason instead of pretending to start", async () => {
		const bridge = new RpcBridge("tab-1", new UnspawnableTransport());

		await expect(bridge.start()).rejects.toThrow(/program not found/);

		const snapshot = bridge.getSnapshot();
		expect(snapshot.status).toBe("error");
		expect(snapshot.error).toBe("program not found");
	});
});

describe("RpcBridge — stall watchdog", () => {
	test("flags a startup that never answers", async () => {
		const bridge = new RpcBridge("tab-1", new ResumingTransport(), { stallAfterMs: 5 });
		await bridge.start();
		expect(bridge.getSnapshot().stalled).toBe(false);

		await new Promise(resolve => setTimeout(resolve, 25));

		// Still `starting`: the child may genuinely be slow. The flag says only that
		// the optimistic message has outlived its usefulness.
		expect(bridge.getSnapshot().status).toBe("starting");
		expect(bridge.getSnapshot().stalled).toBe(true);
	});

	test("a session that comes up is never flagged", async () => {
		const transport = new MockTransport();
		const bridge = new RpcBridge("tab-1", transport, { stallAfterMs: 5 });
		await bridge.start();
		transport.frames({ type: "ready", protocolVersion: 1, maxFrameBytes: 1048576 });

		await new Promise(resolve => setTimeout(resolve, 25));

		expect(bridge.getSnapshot().status).toBe("ready");
		expect(bridge.getSnapshot().stalled).toBe(false);
	});

	test("the flag clears when the session later exits", async () => {
		const transport = new ResumingTransport();
		const bridge = new RpcBridge("tab-1", transport, { stallAfterMs: 5 });
		await bridge.start();
		await new Promise(resolve => setTimeout(resolve, 25));
		expect(bridge.getSnapshot().stalled).toBe(true);

		transport.exit(127);
		await settle();

		expect(bridge.getSnapshot().status).toBe("exited");
		expect(bridge.getSnapshot().stalled).toBe(false);
	});
});

describe("RpcBridge — the plan", () => {
	/*
	 * Mid-turn is the whole point: a phase closes while the agent is still
	 * working, and `get_state` is only asked for at turn boundaries.
	 */
	test("a todo tool result updates the plan without a round trip", async () => {
		const { transport, bridge } = await connected();
		const before = transport.sent.length;

		transport.frames({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "todo",
			isError: false,
			result: {
				content: [],
				details: {
					op: "done",
					phases: [{ name: "Research", tasks: [{ content: "Read it", status: "completed" }] }],
				},
			},
		});
		await settle();

		expect(bridge.getSnapshot().todoPhases).toEqual([
			{ name: "Research", tasks: [{ content: "Read it", status: "completed", blocker: undefined }] },
		]);
		// No `get_state` was needed — the result carried the plan itself.
		expect(transport.sent.slice(before).map(line => JSON.parse(line).type)).not.toContain("get_state");
	});

	test("another tool's result leaves the plan alone", async () => {
		const { transport, bridge } = await connected();
		transport.frames({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "todo",
			isError: false,
			result: { content: [], details: { phases: [{ name: "Research", tasks: [] }] } },
		});
		await settle();
		transport.frames({
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "bash",
			isError: false,
			result: { content: [] },
		});
		await settle();

		expect(bridge.getSnapshot().todoPhases).toHaveLength(1);
	});
});

describe("RpcBridge — booted", () => {
	/*
	 * `status: "ready"` means the process answered something; it says nothing
	 * about the boot sequence being over. `switch_session` aborts the session,
	 * and an abort kills any `bash` in flight — so a panel that fired its first
	 * git command on `ready` had it cancelled, every time a chat was opened.
	 */
	test("a replying process is not yet a booted one", async () => {
		const { transport, bridge } = await connected();
		void bridge.getState();
		await settle();
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "get_state",
			success: true,
			data: { isStreaming: false, sessionId: "s" },
		});
		await settle();

		expect(bridge.getSnapshot().status).toBe("ready");
		expect(bridge.getSnapshot().booted).toBe(false);

		bridge.markBooted();
		await settle();
		expect(bridge.getSnapshot().booted).toBe(true);
	});

	test("restarting takes it back", async () => {
		const { bridge } = await connected();
		bridge.markBooted();
		await settle();
		expect(bridge.getSnapshot().booted).toBe(true);

		await bridge.start();
		await settle();
		expect(bridge.getSnapshot().booted).toBe(false);
	});
});

describe("RpcBridge — compaction", () => {
	/*
	 * The typed command, not `/compact` as a prompt. It went the long way round
	 * while `compact` was handled inside the server's serial command queue —
	 * which meant an `abort` sat behind the very operation it was meant to stop.
	 * `compact` now bypasses that queue, so the typed command is usable again.
	 */
	test("compacting goes out as the compact command", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();

		expect(transport.typeOf(0)).toBe("compact");
	});

	test("the session shows a compaction in flight until the engine says it ended", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		expect(bridge.getSnapshot().compaction).toMatchObject({ origin: "manual" });

		// The engine names the method it settled on without restarting the clock.
		transport.frames({ type: "auto_compaction_start", reason: "manual", action: "remote" });
		await settle();
		expect(bridge.getSnapshot().compaction).toMatchObject({ origin: "manual", action: "remote" });

		transport.frames({
			type: "auto_compaction_end",
			action: "remote",
			aborted: false,
			willRetry: false,
			tokensAfter: 32599,
			result: { summary: "s", tokensBefore: 87272 },
		});
		await settle();

		expect(bridge.getSnapshot().compaction).toBeNull();
		// And the boundary is in the transcript, built from the event itself.
		expect(bridge.getSnapshot().transcript.at(-1)).toMatchObject({
			kind: "compaction",
			tokensBefore: 87272,
			tokensAfter: 32599,
		});
	});

	/*
	 * Measured against the running app: the server had committed the compaction
	 * six minutes before the spinner was still on screen. The banner was waiting
	 * for an event, and an event you can miss is not a backstop — the command's
	 * own response is.
	 */
	test("the command response ends it even if the event never lands", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		expect(bridge.getSnapshot().compaction).not.toBeNull();

		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "compact",
			success: true,
			data: { summary: "s", tokensBefore: 87272 },
		});
		await settle();

		expect(bridge.getSnapshot().compaction).toBeNull();
	});

	test("event then response reloads the history once, not twice", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		const before = transport.sent.length;

		transport.frames({ type: "auto_compaction_end", action: "remote", aborted: false, willRetry: false });
		transport.frames({ type: "response", id: transport.idOf(0), command: "compact", success: true, data: {} });
		await settle();

		const reloads = transport.sent.slice(before).filter(line => JSON.parse(line).type === "get_messages");
		expect(reloads).toHaveLength(1);
		expect(bridge.getSnapshot().compaction).toBeNull();
	});

	/*
	 * "Already compacted" is what the engine says when there is nothing new to
	 * compact. It arrives as a thrown error, but to someone who just pressed the
	 * button it is an answer — a red "Compaction failed" overstates it.
	 */
	test("nothing-to-do reads as a note, not a failure", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "compact",
			success: false,
			error: "Already compacted",
			code: "already_compacted",
		});
		await settle();

		expect(bridge.getSnapshot().error).toBeNull();
		expect(bridge.getSnapshot().warning).toBe("Already compacted");
	});

	/*
	 * The banner used to live only on edges. This is the anchor: whatever frame
	 * goes missing, the next state refresh corrects it — measured against a real
	 * session whose compaction had committed while the spinner was still up.
	 */
	test("a state refresh corrects a banner left up by a missed frame", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		// The server confirms it started; then its end frame never arrives.
		transport.frames({ type: "auto_compaction_start", reason: "manual", action: "remote" });
		await settle();
		expect(bridge.getSnapshot().compaction).not.toBeNull();

		void bridge.getState();
		await settle();
		const index = transport.sent.findIndex(line => JSON.parse(line).type === "get_state");
		transport.frames({
			type: "response",
			id: transport.idOf(index),
			command: "get_state",
			success: true,
			data: { isStreaming: false, isCompacting: false, sessionId: "s" },
		});
		await settle();

		expect(bridge.getSnapshot().compaction).toBeNull();
	});

	/*
	 * The anchor only helps if something asks. With the session otherwise idle
	 * nothing does, so a compaction that finished left the spinner up for good.
	 * While one is open, this client asks on its own.
	 */
	test("an open compaction polls the server on its own", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		const before = transport.sent.filter(line => JSON.parse(line).type === "get_state").length;

		await new Promise(resolve => setTimeout(resolve, 4500));

		const after = transport.sent.filter(line => JSON.parse(line).type === "get_state").length;
		expect(after).toBeGreaterThan(before);
	}, 10_000);

	test("and stops asking once it is over", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		transport.frames({ type: "response", id: transport.idOf(0), command: "compact", success: true, data: {} });
		await settle();
		const settledCount = transport.sent.filter(line => JSON.parse(line).type === "get_state").length;

		await new Promise(resolve => setTimeout(resolve, 4500));

		expect(transport.sent.filter(line => JSON.parse(line).type === "get_state")).toHaveLength(settledCount);
	}, 10_000);

	/* And it must not fire before the server has begun. */
	test("a refresh does not cancel a compaction the server has yet to start", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();

		void bridge.getState();
		await settle();
		const index = transport.sent.findIndex(line => JSON.parse(line).type === "get_state");
		transport.frames({
			type: "response",
			id: transport.idOf(index),
			command: "get_state",
			success: true,
			data: { isStreaming: false, isCompacting: false, sessionId: "s" },
		});
		await settle();

		expect(bridge.getSnapshot().compaction).not.toBeNull();
	});

	test("a refusal is reported instead of swallowed", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "compact",
			success: false,
			error: "Compaction already in progress",
		});
		await settle();

		expect(bridge.getSnapshot().compaction).toBeNull();
		expect(bridge.getSnapshot().error).toContain("Compaction already in progress");
	});

	test("an error can be dismissed", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "compact",
			success: false,
			error: "No model selected",
		});
		await settle();
		expect(bridge.getSnapshot().error).not.toBeNull();

		bridge.clearError();
		await settle();
		// It used to survive until the process was restarted.
		expect(bridge.getSnapshot().error).toBeNull();
	});

	/* Cancelling is the operator's own doing, so the rejection it causes is not
	   a failure to report back at them. */
	test("cancelling takes the banner down without an error", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		expect(bridge.getSnapshot().compaction).not.toBeNull();

		void bridge.cancelCompaction();
		await settle();
		const abortIndex = transport.sent.findIndex(line => JSON.parse(line).type === "abort_compact");
		expect(abortIndex).toBeGreaterThanOrEqual(0);
		transport.frames({ type: "response", id: transport.idOf(abortIndex), command: "abort_compact", success: true });
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "compact",
			success: false,
			error: "Compaction cancelled",
		});
		await settle();

		expect(bridge.getSnapshot().compaction).toBeNull();
		expect(bridge.getSnapshot().error).toBeNull();
	});

	test("an automatic pass brackets itself", async () => {
		const { transport, bridge } = await connected();
		transport.frames({ type: "auto_compaction_start", reason: "threshold", action: "remote" });
		await settle();
		expect(bridge.getSnapshot().compaction).toMatchObject({ origin: "auto", action: "remote" });

		transport.frames({ type: "auto_compaction_end", action: "remote", aborted: false, willRetry: false });
		await settle();
		expect(bridge.getSnapshot().compaction).toBeNull();
	});

	/*
	 * The automatic path emits its end event from inside its own try block, with
	 * the prompt that triggered it still in flight — so paging is refused with
	 * `session_busy` every time. Re-reading has to use the unpaged command.
	 */
	test("reloading after a compaction does not page", async () => {
		const { transport } = await connected();
		const before = transport.sent.length;

		transport.frames({ type: "auto_compaction_start", reason: "threshold", action: "remote" });
		transport.frames({ type: "auto_compaction_end", action: "remote", aborted: false, willRetry: false });
		await settle();

		const asked = transport.sent.slice(before).map(line => JSON.parse(line).type);
		expect(asked).toContain("get_messages");
		expect(asked).not.toContain("get_messages_page");
	});

	/*
	 * "Auto-shake reclaimed ~N tokens but context is still above the threshold;
	 * trying the next preferred compaction method." is the engine falling back,
	 * not failing — the terminal shows it as a warning and then carries on.
	 */
	test("a method fallback is a warning, not a failure", async () => {
		const { transport, bridge } = await connected();
		transport.frames({ type: "auto_compaction_start", reason: "threshold", action: "shake" });
		transport.frames({
			type: "auto_compaction_end",
			action: "shake",
			aborted: false,
			willRetry: false,
			skipped: false,
			errorMessage:
				"Auto-shake reclaimed ~4000 tokens but context is still above the threshold; trying the next preferred compaction method.",
		});
		await settle();

		expect(bridge.getSnapshot().error).toBeNull();
		expect(bridge.getSnapshot().warning).toContain("trying the next preferred");

		bridge.clearWarning();
		await settle();
		expect(bridge.getSnapshot().warning).toBeNull();
	});

	/*
	 * Eviction is routine — three live sessions and LRU — and it kills the very
	 * process the compaction was running in. Nothing else will ever report back.
	 */
	/*
	 * One refusal, one banner. `errorMessage` cannot distinguish "falling back"
	 * from "failed", and a run this client started already gets a precise answer
	 * from its own response — reporting both left an amber warning and a red
	 * error on screen for the same "Already compacted".
	 */
	test("a manual failure is reported once, by its response", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		transport.frames({
			type: "auto_compaction_end",
			action: "remote",
			aborted: false,
			willRetry: false,
			errorMessage: "remote compaction failed",
		});
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "compact",
			success: false,
			error: "remote compaction failed",
		});
		await settle();

		expect(bridge.getSnapshot().warning).toBeNull();
		expect(bridge.getSnapshot().error).toContain("remote compaction failed");
	});

	test("a suspended sidecar takes its compaction with it", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		expect(bridge.getSnapshot().compaction).not.toBeNull();

		transport.evict();
		await settle();

		expect(bridge.getSnapshot().compaction).toBeNull();
	});

	test("a failed compaction does not try to re-read anything", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		const before = transport.sent.length;
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "compact",
			success: false,
			error: "remote compaction failed",
		});
		await settle();

		const asked = transport.sent.slice(before).map(line => JSON.parse(line).type);
		expect(asked).not.toContain("get_messages");
		expect(bridge.getSnapshot().error).toContain("remote compaction failed");
	});
});

describe("RpcBridge — plan mode", () => {
	test("the toggle is a command, and the state is re-read after it", async () => {
		const { transport, bridge } = await connected();
		void bridge.setPlanMode(true);
		await settle();

		expect(transport.typeOf(0)).toBe("set_plan_mode");
		expect(JSON.parse(transport.sent[0]).enabled).toBe(true);

		transport.frames({ type: "response", id: transport.idOf(0), command: "set_plan_mode", success: true });
		await settle();
		expect(transport.sent.map(line => JSON.parse(line).type)).toContain("get_state");
	});

	/*
	 * The terminal can move the mode too. A client that remembered what it last
	 * asked for would go quietly wrong; this one re-reads on the event.
	 */
	test("someone else changing the mode refreshes the state", async () => {
		const { transport } = await connected();
		const before = transport.sent.length;

		transport.frames({ type: "plan_mode_changed", enabled: true, planFilePath: "local://x-plan.md" });
		await settle();

		expect(transport.sent.slice(before).map(line => JSON.parse(line).type)).toContain("get_state");
	});

	test("a refusal is reported, not swallowed", async () => {
		const { transport, bridge } = await connected();
		void bridge.setPlanMode(true);
		await settle();
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "set_plan_mode",
			success: false,
			error: "Plan mode is disabled. Enable it in settings (plan.enabled).",
		});
		await settle();

		expect(bridge.getSnapshot().error).toContain("plan.enabled");
	});
});

describe("RpcBridge — session state stays fresh", () => {
	/*
	 * The engine's only narration during a manual run: it emits these when a
	 * method turns out to be unavailable and it falls back to the next one. Not
	 * a failure — the run continues and usually succeeds.
	 */
	test("fallback narration is shown, not treated as failure", async () => {
		const { transport, bridge } = await connected();
		void bridge.startCompaction();
		await settle();
		transport.frames({
			type: "notice",
			level: "warning",
			source: "compaction",
			message: "remote compaction is unavailable for gpt-5.6-luna; trying the next preferred method",
		});
		await settle();

		expect(bridge.getSnapshot().compaction?.note).toContain("trying the next preferred method");
		expect(bridge.getSnapshot().error).toBeNull();
	});

	/*
	 * `#state` has one writer, and it used to be woken by exactly two frame
	 * types. Everything derived from it — the working indicator, the sidebar's
	 * activity dot, the turn-finished notification, Escape-to-abort — was
	 * reading a snapshot taken at boot.
	 */
	test("turn boundaries refresh the session state", async () => {
		const { transport } = await connected();
		const before = transport.sent.length;

		transport.frames({ type: "turn_end" });
		await settle();

		const asked = transport.sent.slice(before).map(line => JSON.parse(line).type);
		expect(asked).toContain("get_state");
	});

	/*
	 * The trailing repeat matters: the reply to the `turn_start` ask was computed
	 * before `turn_end` existed, so a plain in-flight skip would leave the client
	 * believing the turn is still streaming.
	 */
	test("a burst collapses to one refresh plus one trailing repeat", async () => {
		const { transport } = await connected();
		const before = transport.sent.length;

		transport.frames({ type: "turn_start" });
		transport.frames({ type: "agent_start" });
		transport.frames({ type: "turn_end" });
		await settle();

		const first = transport.sent.slice(before).filter(line => JSON.parse(line).type === "get_state");
		expect(first).toHaveLength(1);

		const index = transport.sent.findIndex(line => JSON.parse(line).type === "get_state");
		transport.frames({
			type: "response",
			id: transport.idOf(index),
			command: "get_state",
			success: true,
			data: { isStreaming: false, sessionId: "s" },
		});
		await settle();

		expect(transport.sent.filter(line => JSON.parse(line).type === "get_state")).toHaveLength(2);
	});

	test("an unrelated event does not", async () => {
		const { transport, bridge } = await connected();
		const before = transport.sent.length;

		transport.frames({ type: "message_update", message: { role: "assistant", content: [] } });
		await settle();

		expect(transport.sent.slice(before).map(line => JSON.parse(line).type)).not.toContain("get_state");
		expect(bridge.getSnapshot()).toBeDefined();
	});
});

describe("RpcBridge — blocking UI requests", () => {
	const ask = (id: string, title: string) => ({
		type: "extension_ui_request" as const,
		id,
		method: "select" as const,
		title,
		options: ["a", "b"],
	});

	test("a second question waits its turn instead of erasing the first", async () => {
		// One slot meant the server was left holding a promise nobody could answer:
		// the overwritten request never reached a human and never resolved.
		const { transport, bridge } = await connected();

		transport.frames(ask("q1", "first"), ask("q2", "second"));
		await settle();
		expect(bridge.getSnapshot().pendingUi?.id).toBe("q1");

		bridge.answerUi({ id: "q1", value: "a" });
		await settle();
		expect(bridge.getSnapshot().pendingUi?.id).toBe("q2");

		bridge.answerUi({ id: "q2", value: "b" });
		await settle();
		expect(bridge.getSnapshot().pendingUi).toBeNull();
		// Both were answered, in order.
		const answers = transport.sent
			.map(line => JSON.parse(line))
			.filter(frame => frame.type === "extension_ui_response");
		expect(answers.map(frame => frame.id)).toEqual(["q1", "q2"]);
	});

	test("a cancelled question is withdrawn, and the next one takes the screen", async () => {
		// The server settles its own side before sending this, so there is nothing
		// to answer — the dialog just has to go, and while it is up it also
		// suppresses Escape-to-abort.
		const { transport, bridge } = await connected();

		transport.frames(ask("q1", "first"), ask("q2", "second"));
		await settle();
		transport.frames({ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "q1" });
		await settle();

		expect(bridge.getSnapshot().pendingUi?.id).toBe("q2");
		expect(transport.sent.map(line => JSON.parse(line)).some(frame => frame.id === "q1")).toBe(false);
	});

	test("cancelling one that is still queued removes it without disturbing the screen", async () => {
		const { transport, bridge } = await connected();

		transport.frames(ask("q1", "first"), ask("q2", "second"));
		await settle();
		transport.frames({ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "q2" });
		await settle();
		expect(bridge.getSnapshot().pendingUi?.id).toBe("q1");

		bridge.answerUi({ id: "q1", value: "a" });
		await settle();
		expect(bridge.getSnapshot().pendingUi).toBeNull();
	});

	test("a restart drops questions the dead process asked", async () => {
		const { transport, bridge } = await connected();

		transport.frames(ask("q1", "first"));
		await settle();
		expect(bridge.getSnapshot().pendingUi).not.toBeNull();

		await bridge.start();
		expect(bridge.getSnapshot().pendingUi).toBeNull();
	});
});

describe("RpcBridge — a prompt that lands mid-turn", () => {
	test("carries a streaming behaviour, so the server queues instead of refusing", async () => {
		const { transport, bridge } = await connected();
		void bridge.prompt("ship it");
		await settle();

		// The server throws `AgentBusyError` for a prompt that arrives while a turn
		// is running and says nothing about what to do with it. This client picks
		// prompt-vs-steer from a state snapshot refreshed only at turn boundaries,
		// so it is wrong for the length of a round trip, every turn.
		expect(JSON.parse(transport.sent[0])).toMatchObject({ type: "prompt", streamingBehavior: "steer" });
	});

	test("a failure arriving after the acknowledgement reaches the banner and the sender", async () => {
		const { transport, bridge } = await connected();
		const refusals: string[] = [];
		const sent = bridge.prompt("ship it", undefined, cause => refusals.push(cause.message));
		await settle();

		// The handler acknowledges the frame and only then runs the turn, so both
		// of these carry the same id and the second one has nothing to settle.
		transport.frames({ type: "response", id: transport.idOf(0), command: "prompt", success: true });
		await sent;
		// Whatever the client asks in the meantime mints its own id and must not
		// stand in for the prompt's still-unanswered turn.
		void bridge.getState();
		await settle();
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "prompt",
			success: false,
			error: "No model selected",
		});
		await settle();

		expect(bridge.getSnapshot().error).toBe("No model selected");
		// The banner can say what went wrong; only the caller still holds the
		// message the server refused to take.
		expect(refusals).toEqual(["No model selected"]);
	});

	test("a refusal batched with the acknowledgement is seen before the send resolves", async () => {
		const { transport, bridge } = await connected();
		const order: string[] = [];
		const sent = bridge.prompt("ship it", undefined, () => order.push("refused")).then(() => order.push("resolved"));
		await settle();

		// One relay batch carrying both answers, read synchronously by the webview.
		transport.frames(
			{ type: "response", id: transport.idOf(0), command: "prompt", success: true },
			{ type: "response", id: transport.idOf(0), command: "prompt", success: false, error: "No model selected" },
		);
		await sent;

		expect(order).toEqual(["refused", "resolved"]);
	});

	test("another command failing late is not mistaken for the prompt's refusal", async () => {
		const { transport, bridge } = await connected();
		const refusals: string[] = [];
		const sent = bridge.prompt("ship it", undefined, cause => refusals.push(cause.message));
		await settle();
		transport.frames({ type: "response", id: transport.idOf(0), command: "prompt", success: true });
		await sent;
		transport.frames({ type: "response", id: "d999", command: "bash", success: false, error: "boom" });
		await settle();

		expect(refusals).toEqual([]);
		expect(bridge.getSnapshot().error).toBe("boom");
	});
});

/**
 * `#state` is a photograph, and `get_state` is the only thing that retakes it.
 *
 * A turn that was running when the child died therefore left `isStreaming` true
 * in that photograph forever — the refresh is driven by `turn_end`, which a dead
 * process never sends. Everything that asks whether a session is busy reads that
 * flag: the sidebar's dot, the close guard, the composer's Stop button.
 */
describe("RpcBridge — a dead process is not mid-turn", () => {
	async function midTurn() {
		const { transport, bridge } = await connected();
		void bridge.getState();
		await settle();
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "get_state",
			success: true,
			data: { isStreaming: true, isCompacting: false, sessionId: "s" },
		});
		await settle();
		expect(bridge.getSnapshot().state?.isStreaming).toBe(true);
		return { transport, bridge };
	}

	test("a crash clears the streaming flag along with the status", async () => {
		const { transport, bridge } = await midTurn();
		transport.exit(1);
		await settle();
		expect(bridge.getSnapshot().status).toBe("exited");
		expect(bridge.getSnapshot().state?.isStreaming).toBe(false);
	});

	test("so does an eviction, which is the routine kill rather than the rare one", async () => {
		const { transport, bridge } = await midTurn();
		transport.evict();
		await settle();
		expect(bridge.getSnapshot().status).toBe("suspended");
		expect(bridge.getSnapshot().state?.isStreaming).toBe(false);
	});

	test("and a relay fault, which is the one death nothing else corrects", async () => {
		const { transport, bridge } = await midTurn();
		transport.fault("relay went away");
		await settle();
		expect(bridge.getSnapshot().status).toBe("error");
		expect(bridge.getSnapshot().state?.isStreaming).toBe(false);
	});
});

/**
 * A deadline the server does not police once it has expired.
 *
 * `requestRpcDialog` resolves its default on timeout, drops the pending request
 * and sends NOTHING — the `cancel` frame is the abort path, not the timeout
 * path. The deadline rides on the request frame precisely so the client can run
 * it, and nothing here did: the modal stayed up over a question the server had
 * stopped waiting for, holding the composer and the queue behind it. `login`
 * ships a 600s one, so this is not extension-only.
 */
describe("RpcBridge — a question the server stops waiting for", () => {
	const ask = (id: string, timeout?: number) => ({
		type: "extension_ui_request",
		id,
		method: "select",
		title: id,
		options: ["a", "b"],
		...(timeout === undefined ? {} : { timeout }),
	});

	const responses = (transport: { sent: string[] }) =>
		transport.sent.map(line => JSON.parse(line)).filter(frame => frame.type === "extension_ui_response");

	test("a dialog carrying a deadline takes itself down when the deadline passes", async () => {
		const { transport, bridge } = await connected();
		transport.frames(ask("q1", 20));
		await settle();
		expect(bridge.getSnapshot().pendingUi?.id).toBe("q1");

		await new Promise(resolve => setTimeout(resolve, 60));
		expect(bridge.getSnapshot().pendingUi).toBeNull();
		expect(responses(transport)).toEqual([
			{ type: "extension_ui_response", id: "q1", cancelled: true, timedOut: true },
		]);
	});

	test("the deadline runs while a question waits its turn", async () => {
		const { transport, bridge } = await connected();
		transport.frames(ask("q1"), ask("q2", 20));
		await settle();
		await new Promise(resolve => setTimeout(resolve, 60));

		bridge.answerUi({ id: "q1", value: "a" });
		await settle();
		// q2 expired unseen rather than taking the screen after q1 was answered.
		expect(bridge.getSnapshot().pendingUi).toBeNull();
	});

	test("a question with no deadline waits as long as the person does", async () => {
		const { transport, bridge } = await connected();
		transport.frames(ask("q1"));
		await settle();
		await new Promise(resolve => setTimeout(resolve, 60));
		expect(bridge.getSnapshot().pendingUi?.id).toBe("q1");
	});
});
