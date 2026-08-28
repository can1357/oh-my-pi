import { describe, expect, test } from "bun:test";
import { bootSession, rememberedSession, rememberSession, resumeTarget } from "../src/rpc/boot";
import { RpcBridge } from "../src/rpc/bridge";
import type { RpcSessionState } from "../src/rpc/protocol";
import type { AgentHandle, PoolStatus, RelayEvent, Transport } from "../src/rpc/transport";

/**
 * A relay the test scripts: it records what the bridge sent and answers one
 * command at a time, so the boot sequence can be walked step by step.
 */
class ScriptedTransport implements Transport {
	sent: string[] = [];
	/** What `agent_start` reports. A respawn after an eviction is `false`. */
	resumed = false;
	#emit: ((event: RelayEvent) => void) | null = null;
	#tabId = "";

	async start(tabId: string, onEvent: (event: RelayEvent) => void): Promise<AgentHandle> {
		this.#tabId = tabId;
		this.#emit = onEvent;
		return { pid: 4242, resumed: this.resumed, prewarmed: false };
	}

	async send(_tabId: string, line: string): Promise<void> {
		this.sent.push(line);
	}

	async suspend(): Promise<void> {}

	async kill(): Promise<void> {}

	async poolStatus(): Promise<PoolStatus> {
		return { live: 1, maxLive: 3, prewarmReady: true, tabs: [this.#tabId] };
	}

	// -- test helpers --

	types(): string[] {
		return this.sent.map(line => JSON.parse(line).type as string);
	}

	/** The newest command of this type, as the bridge wrote it. */
	last(type: string): Record<string, unknown> | undefined {
		const index = this.types().lastIndexOf(type);
		return index < 0 ? undefined : (JSON.parse(this.sent[index]) as Record<string, unknown>);
	}

	/** Answer the newest command of this type the way the sidecar would. */
	reply(type: string, data: unknown = {}): void {
		const frame = this.last(type);
		if (!frame) throw new Error(`the bridge never sent a ${type}`);
		this.#emit?.({
			event: "frames",
			data: {
				tabId: this.#tabId,
				lines: [JSON.stringify({ type: "response", id: frame.id, command: type, success: true, data })],
			},
		});
	}
}

/** Let queued microtasks (writes, snapshot notifications) run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function sessionState(overrides: Partial<RpcSessionState>): RpcSessionState {
	return {
		isStreaming: false,
		isCompacting: false,
		sessionId: "s",
		autoCompactionEnabled: true,
		fastModeEnabled: false,
		fastModeActive: false,
		tokensPerSecond: null,
		messageCount: 0,
		queuedMessageCount: 0,
		todoPhases: [],
		...overrides,
	};
}

/** Answer the three idempotent queries every boot opens with. */
async function answerOpeningQueries(transport: ScriptedTransport, state: RpcSessionState): Promise<void> {
	await settle();
	transport.reply("get_state", state);
	await settle();
	transport.reply("get_available_commands", { commands: [] });
	await settle();
	transport.reply("set_subagent_subscription", {});
	await settle();
}

describe("bootSession — a tab keeps its session across processes", () => {
	/*
	 * The pool evicts the least-recently-used sidecar when a fourth tab opens, and
	 * returning to the evicted tab spawns a fresh one. A chat started in the app
	 * carries no `sessionPath` — writing one would re-run this boot on a live tab,
	 * and `switch_session` aborts — so nothing used to point the new process
	 * anywhere. The tab was declared booted over a brand-new empty session while
	 * the old transcript was still on screen, and the next prompt went into a
	 * different jsonl from the one being displayed.
	 */
	/*
	 * A refusal is not a failure, and that is what made it dangerous. An extension
	 * vetoing `session_before_switch`, or a cwd the session disagrees with, both
	 * come back as a RESOLVED `{ cancelled: true }` — so awaiting and discarding
	 * the answer read them as success. The process stayed on the throwaway session
	 * it booted with while the tab showed the one that was asked for, and the next
	 * prompt was written to the throwaway.
	 */
	test("a refused switch is reported, not taken for success", async () => {
		const transport = new ScriptedTransport();
		const bridge = new RpcBridge("new:vetoed", transport);
		rememberSession("new:vetoed", "/sessions/wanted.jsonl");

		const booting = bootSession(bridge, {});
		await answerOpeningQueries(
			transport,
			sessionState({ sessionId: "throwaway", sessionFile: "/sessions/throwaway.jsonl" }),
		);

		expect(transport.last("switch_session")?.sessionPath).toBe("/sessions/wanted.jsonl");
		transport.reply("switch_session", { cancelled: true });
		await booting;
		await settle();

		expect(bridge.getSnapshot().error).toContain("refused");
	});

	test("a respawned process is pointed back at the session the tab was on", async () => {
		const transport = new ScriptedTransport();
		const bridge = new RpcBridge("new:evicted", transport);
		rememberSession("new:evicted", "/sessions/live.jsonl");

		const booting = bootSession(bridge, {});
		await answerOpeningQueries(
			transport,
			sessionState({ sessionId: "throwaway", sessionFile: "/sessions/throwaway.jsonl" }),
		);

		expect(transport.last("switch_session")?.sessionPath).toBe("/sessions/live.jsonl");

		transport.reply("switch_session", { cancelled: false });
		await settle();
		transport.reply("get_state", sessionState({ sessionId: "live", sessionFile: "/sessions/live.jsonl" }));
		await settle();
		transport.reply("get_messages_page", { messages: [], totalMessages: 0 });
		await booting;

		expect(bridge.getSnapshot().booted).toBe(true);
		expect(rememberedSession("new:evicted")).toBe("/sessions/live.jsonl");
	});

	test("a first boot leaves a new chat where it is, and remembers where that was", async () => {
		const transport = new ScriptedTransport();
		const bridge = new RpcBridge("new:first", transport);

		const booting = bootSession(bridge, {});
		await answerOpeningQueries(transport, sessionState({ sessionId: "first", sessionFile: "/sessions/first.jsonl" }));
		await booting;

		expect(transport.types()).not.toContain("switch_session");
		expect(rememberedSession("new:first")).toBe("/sessions/first.jsonl");
	});

	/*
	 * The hazard the ordering exists for. Going to Settings mid-turn and coming
	 * back remounts the view, which mints a new bridge and re-runs this boot
	 * against the same live process — and `switch_session` would take the turn
	 * with it.
	 */
	test("a re-attached process is never switched, whatever the tab remembers", async () => {
		const transport = new ScriptedTransport();
		transport.resumed = true;
		const bridge = new RpcBridge("tab-live", transport);
		rememberSession("tab-live", "/sessions/live.jsonl");

		const booting = bootSession(bridge, { sessionPath: "/sessions/live.jsonl" });
		await answerOpeningQueries(transport, sessionState({ sessionId: "other", sessionFile: "/sessions/other.jsonl" }));
		transport.reply("get_messages", { messages: [] });
		await booting;

		expect(transport.types()).not.toContain("switch_session");
		expect(transport.types()).toContain("get_messages");
	});
});

describe("resumeTarget", () => {
	test("a saved session's first boot still switches to the path it was opened with", () => {
		expect(
			resumeTarget({ sessionPath: "/sessions/a.jsonl", resumed: false, current: "/sessions/throwaway.jsonl" }),
		).toBe("/sessions/a.jsonl");
	});

	test("where the tab was seen outranks the path it was opened with", () => {
		expect(
			resumeTarget({
				sessionPath: "/sessions/a.jsonl",
				resumed: false,
				remembered: "/sessions/b.jsonl",
				current: "/sessions/throwaway.jsonl",
			}),
		).toBe("/sessions/b.jsonl");
	});

	test("a process already on the right session is left alone", () => {
		expect(
			resumeTarget({ resumed: false, remembered: "/sessions/a.jsonl", current: "/sessions/a.jsonl" }),
		).toBeNull();
	});

	test("a resumed process is left alone even when it disagrees", () => {
		expect(
			resumeTarget({
				sessionPath: "/sessions/a.jsonl",
				resumed: true,
				remembered: "/sessions/a.jsonl",
				current: "/sessions/b.jsonl",
			}),
		).toBeNull();
	});
});

describe("RpcBridge — switching re-reads the state", () => {
	/*
	 * `#state` has one writer, `getState`, woken by turn and compaction boundaries.
	 * A switch is neither, so the status bar's model, thinking level and context
	 * usage — and the model picker's selection — went on describing the throwaway
	 * session the sidecar booted into until the first turn event happened to
	 * refresh them.
	 */
	test("the state after a switch describes the session that was opened", async () => {
		const transport = new ScriptedTransport();
		const bridge = new RpcBridge("tab-saved", transport);

		const booting = bootSession(bridge, { sessionPath: "/sessions/saved.jsonl" });
		await answerOpeningQueries(
			transport,
			sessionState({ sessionId: "throwaway", sessionFile: "/sessions/throwaway.jsonl" }),
		);
		expect(bridge.getSnapshot().state?.sessionId).toBe("throwaway");

		transport.reply("switch_session", { cancelled: false });
		await settle();
		transport.reply(
			"get_state",
			sessionState({ sessionId: "saved", sessionFile: "/sessions/saved.jsonl", messageCount: 42 }),
		);
		await settle();
		transport.reply("get_messages_page", { messages: [], totalMessages: 0 });
		await booting;

		expect(bridge.getSnapshot().state?.sessionId).toBe("saved");
		expect(bridge.getSnapshot().state?.messageCount).toBe(42);
	});

	test("a switch the server refused re-reads nothing", async () => {
		const transport = new ScriptedTransport();
		const bridge = new RpcBridge("tab-cancelled", transport);

		const booting = bootSession(bridge, { sessionPath: "/sessions/saved.jsonl" });
		await answerOpeningQueries(
			transport,
			sessionState({ sessionId: "throwaway", sessionFile: "/sessions/throwaway.jsonl" }),
		);
		transport.reply("switch_session", { cancelled: true });
		await booting;

		expect(transport.types()).not.toContain("get_messages_page");
		expect(transport.types().filter(type => type === "get_state")).toHaveLength(1);
	});
});

/*
 * The one hop of this boot the client itself owns.
 *
 * Spawn dominates a cold open and nothing here changes that — but every command
 * awaited on its own line is another round trip the user waits through, and
 * three of these depend on nothing. Against a relay answering in 20 ms, a cold
 * open of a 600-message session took 197 ms of round trips serialised and
 * 115 ms with the independent ones dispatched together.
 */
describe("bootSession — round trips it does not have to serialise", () => {
	test("the three opening queries go out together, not one after another", async () => {
		const transport = new ScriptedTransport();
		const bridge = new RpcBridge("tab-parallel", transport);

		const booting = bootSession(bridge, {});
		// Nothing has been answered yet, so anything on the wire at this point was
		// sent without waiting for the command before it.
		await settle();

		expect(transport.types()).toEqual(["get_state", "get_available_commands", "set_subagent_subscription"]);

		await answerOpeningQueries(transport, sessionState({ sessionFile: "/sessions/parallel.jsonl" }));
		await booting;

		expect(bridge.getSnapshot().booted).toBe(true);
	});

	test("the state re-read and the first history page are asked for together", async () => {
		const transport = new ScriptedTransport();
		const bridge = new RpcBridge("tab-switch-parallel", transport);

		const booting = bootSession(bridge, { sessionPath: "/sessions/saved.jsonl" });
		await answerOpeningQueries(
			transport,
			sessionState({ sessionId: "throwaway", sessionFile: "/sessions/throwaway.jsonl" }),
		);
		transport.reply("switch_session", { cancelled: false });
		await settle();

		// Neither feeds the other, so neither has a reason to wait on the other's
		// response. Paging a long session is the slow part; it should not start a
		// round trip late.
		expect(transport.types()).toContain("get_messages_page");
		expect(transport.types().filter(type => type === "get_state")).toHaveLength(2);

		transport.reply("get_state", sessionState({ sessionId: "saved", sessionFile: "/sessions/saved.jsonl" }));
		await settle();
		transport.reply("get_messages_page", {
			messages: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "hello" }] }],
			totalMessages: 1,
		});
		await booting;

		// Overlapping them cost the transcript nothing: the page still landed, and
		// the state still describes the session that was opened.
		expect(bridge.getSnapshot().transcript).toHaveLength(1);
		expect(bridge.getSnapshot().state?.sessionId).toBe("saved");
	});
});
