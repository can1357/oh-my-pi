import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	applyReplicaEvent,
	applyReplicaHostState,
	ingestReplicaEntry,
	loadReplica,
	ReplicaActivationCancelledError,
	resetReplicaEventState,
} from "@oh-my-pi/pi-coding-agent/session/replica-view";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let model: Model;

beforeAll(() => {
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("expected bundled anthropic model");
	model = bundled;
});

afterAll(() => {
	authStorage.close();
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Real local session rooted in a temp cwd, like a TUI that is about to mirror a remote session. */
function makeLocalSession(options: { passiveReplica?: boolean } = {}): { session: AgentSession; cwd: string } {
	const tempDir = TempDir.createSync("@pi-replica-view-");
	const cwd = tempDir.path();
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry,
		passiveReplica: options.passiveReplica,
	});
	cleanups.push(async () => {
		await session.dispose().catch(() => {});
		await tempDir.remove().catch(() => {});
	});
	return { session, cwd };
}

/** A remote (host) session whose transcript the replica mirrors. */
function makeHostManager(): SessionManager {
	const host = SessionManager.inMemory();
	host.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	host.appendMessage(createAssistantMessage("reply"));
	return host;
}

function textOf(message: { role: string; content?: unknown }): string {
	return typeof message.content === "string" ? message.content : message.role;
}

describe("loadReplica", () => {
	it("makes the local session hold the host entries while keeping the local cwd", async () => {
		const { session, cwd } = makeLocalSession();
		const { header, entries } = makeHostManager().snapshotForReplication();
		const replicaPath = path.join(cwd, "replica", "room.jsonl");

		const activated = await loadReplica(session, replicaPath, header, entries);

		expect(activated).toBe(true);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(session.sessionManager.getCwd()).toBe(cwd);
		expect(session.messages.map(textOf)).toEqual(["first", "assistant"]);
	});

	it("does not activate when the caller is gone after the file is written", async () => {
		const { session, cwd } = makeLocalSession();
		const { header, entries } = makeHostManager().snapshotForReplication();
		const before = session.sessionManager.getSessionFile();

		const activated = await loadReplica(session, path.join(cwd, "replica.jsonl"), header, entries, {
			isLive: () => false,
		});

		expect(activated).toBe(false);
		expect(session.sessionManager.getSessionFile()).toBe(before);
		expect(session.sessionManager.getEntries()).toEqual([]);
	});

	it("surfaces a cancelled session switch as a typed error", async () => {
		const { session, cwd } = makeLocalSession();
		const { header, entries } = makeHostManager().snapshotForReplication();
		const switchSpy = spyOn(session, "switchSession").mockResolvedValue(false);

		await expect(loadReplica(session, path.join(cwd, "replica.jsonl"), header, entries)).rejects.toBeInstanceOf(
			ReplicaActivationCancelledError,
		);
		expect(switchSpy).toHaveBeenCalledWith(path.join(cwd, "replica.jsonl"), {
			preserveLocalCwd: true,
			keepModel: true,
		});
	});

	it("puts the replica on the host's leaf, with that branch's messages and todo list, not the journal's last entry", async () => {
		const { session, cwd } = makeLocalSession({ passiveReplica: true });
		const host = makeHostManager();
		const forkPoint = host.getEntries().at(-1)!.id;
		const todos = (task: string): TodoPhase[] => [{ name: "Work", tasks: [{ content: task, status: "pending" }] }];
		host.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: todos("task A") });
		const branchA = host.appendMessage({ role: "user", content: "branch A", timestamp: Date.now() });
		host.branch(forkPoint);
		host.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: todos("task B") });
		host.appendMessage({ role: "user", content: "branch B", timestamp: Date.now() });
		host.branch(branchA);
		const { header, entries } = host.snapshotForReplication();
		const plain = makeLocalSession();

		await loadReplica(session, path.join(cwd, "replica.jsonl"), header, entries, { leafId: host.getLeafId() });
		await loadReplica(plain.session, path.join(plain.cwd, "replica.jsonl"), header, entries);

		expect(session.sessionManager.getLeafId()).toBe(branchA);
		expect(session.messages.map(textOf)).toEqual(["first", "assistant", "branch A"]);
		// The todo list the HUD reloads is the branch's, not the last physical branch's the load restored.
		expect(session.getTodoPhases()).toEqual(todos("task A"));
		expect(session.sessionManager.getEntries()).toEqual(entries);
		// Without the option the loader keeps its choice: the last journal entry, on branch B.
		expect(plain.session.messages.map(textOf)).toEqual(["first", "assistant", "branch B"]);
		expect(plain.session.getTodoPhases()).toEqual(todos("task B"));
		// Following the host's branch is only for a passive replica.
		await expect(
			loadReplica(plain.session, path.join(plain.cwd, "again.jsonl"), header, entries, { leafId: branchA }),
		).rejects.toThrow(/passive replica/);
	});

	it("never exposes a truncated replica while a resync overwrites it", async () => {
		const { session, cwd } = makeLocalSession();
		const host = makeHostManager();
		const first = host.snapshotForReplication();
		const replicaPath = path.join(cwd, "replica", "room.jsonl");
		await loadReplica(session, replicaPath, first.header, first.entries);
		const before = await Bun.file(replicaPath).text();
		host.appendMessage({ role: "user", content: "later", timestamp: Date.now() });
		const second = host.snapshotForReplication();
		const realRename = fsp.rename;
		let visibleBeforePublish: string | undefined;
		const renameSpy = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
			if (to === replicaPath && visibleBeforePublish === undefined) {
				visibleBeforePublish = await Bun.file(replicaPath).text();
			}
			await realRename(from, to);
		});

		try {
			await loadReplica(session, replicaPath, second.header, second.entries);
		} finally {
			renameSpy.mockRestore();
		}

		// A reader (`omp gc` probing the header id) sees the whole previous replica until the new one lands in one rename.
		expect(visibleBeforePublish).toBe(before);
		expect(await Bun.file(replicaPath).text()).toContain("later");
		expect(await fsp.readdir(path.dirname(replicaPath))).toEqual(["room.jsonl"]);
	});

	it("keeps the previous replica and leaves no temp file when the overwrite cannot be published", async () => {
		const { session, cwd } = makeLocalSession();
		const host = makeHostManager();
		const first = host.snapshotForReplication();
		const replicaPath = path.join(cwd, "replica", "room.jsonl");
		await loadReplica(session, replicaPath, first.header, first.entries);
		const before = await Bun.file(replicaPath).text();
		host.appendMessage({ role: "user", content: "later", timestamp: Date.now() });
		const second = host.snapshotForReplication();
		const realRename = fsp.rename;
		const renameSpy = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
			if (to === replicaPath) throw new Error("rename failed");
			await realRename(from, to);
		});

		try {
			await expect(loadReplica(session, replicaPath, second.header, second.entries)).rejects.toThrow(
				"rename failed",
			);
		} finally {
			renameSpy.mockRestore();
		}

		expect(await Bun.file(replicaPath).text()).toBe(before);
		expect(await fsp.readdir(path.dirname(replicaPath))).toEqual(["room.jsonl"]);
	});
});

describe("ingestReplicaEntry", () => {
	it("appends host messages to the replica entries and the agent message list", async () => {
		const { session, cwd } = makeLocalSession();
		const host = makeHostManager();
		const { header, entries } = host.snapshotForReplication();
		await loadReplica(session, path.join(cwd, "replica.jsonl"), header, entries);

		const liveId = host.appendMessage({ role: "user", content: "live", timestamp: Date.now() });
		const liveEntry = host.getEntry(liveId);
		if (!liveEntry) throw new Error("expected live entry");
		ingestReplicaEntry(session, liveEntry);

		expect(session.sessionManager.getEntries().at(-1)).toEqual(liveEntry);
		expect(session.messages.map(textOf)).toEqual(["first", "assistant", "live"]);
	});

	it("rebuilds the message list behind a compaction summary", async () => {
		const { session, cwd } = makeLocalSession();
		const host = makeHostManager();
		const keptId = host.appendMessage({ role: "user", content: "keep", timestamp: Date.now() });
		const { header, entries } = host.snapshotForReplication();
		await loadReplica(session, path.join(cwd, "replica.jsonl"), header, entries);
		expect(session.messages.map(textOf)).toEqual(["first", "assistant", "keep"]);

		const compactionId = host.appendCompaction("SUMMARY", undefined, keptId, 100);
		const compactionEntry = host.getEntry(compactionId);
		if (!compactionEntry) throw new Error("expected compaction entry");
		ingestReplicaEntry(session, compactionEntry);

		expect(session.messages).toEqual(session.buildDisplaySessionContext().messages);
		expect(session.messages).toHaveLength(2);
		expect(session.messages[0]).toMatchObject({ role: "compactionSummary", summary: "SUMMARY" });
		expect(session.messages[1]).toMatchObject({ role: "user", content: "keep" });
	});

	it("follows the host's final leaf: an off-branch append is journaled without touching the branch", async () => {
		const { session, cwd } = makeLocalSession({ passiveReplica: true });
		const host = makeHostManager();
		const { header, entries } = host.snapshotForReplication();
		await loadReplica(session, path.join(cwd, "replica.jsonl"), header, entries, { leafId: host.getLeafId() });
		const frames: Array<{ entry: SessionEntry; leafId: string | null }> = [];
		host.subscribeEntryAppended((entry, leafId) => frames.push({ entry: structuredClone(entry), leafId }));

		const retained = host.appendMessageToBranch(
			{ role: "user", content: "retained", timestamp: Date.now() },
			entries[0].id,
		);
		const next = host.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		for (const { entry, leafId } of frames) ingestReplicaEntry(session, entry, { leafId });

		expect(session.sessionManager.getEntries().some(entry => entry.id === retained)).toBe(true);
		expect(session.sessionManager.getLeafId()).toBe(next);
		expect(session.messages.map(textOf)).toEqual(["first", "assistant", "continue"]);
	});

	it("keeps the branch until the leaf the host named arrives, then shows every entry on the way to it, whatever that last entry is", async () => {
		const { session, cwd } = makeLocalSession({ passiveReplica: true });
		const host = makeHostManager();
		const { header, entries } = host.snapshotForReplication();
		await loadReplica(session, path.join(cwd, "replica.jsonl"), header, entries, { leafId: host.getLeafId() });
		const frames: Array<{ entry: SessionEntry; leafId: string | null }> = [];
		host.subscribeEntryAppended(entry => frames.push({ entry: structuredClone(entry), leafId: null }));

		host.appendMessage({ role: "user", content: "batched one", timestamp: Date.now() });
		host.appendMessage({ role: "user", content: "batched two", timestamp: Date.now() });
		await host.setSessionName("Named after the batch", "user");
		// The host announced them once its batch settled, so each frame names the leaf it had by then: the title.
		const title = host.getLeafId();
		const [first, second, renamed] = frames.map(frame => ({ entry: frame.entry, leafId: title }));

		ingestReplicaEntry(session, first.entry, first);
		ingestReplicaEntry(session, second.entry, second);
		expect(session.sessionManager.getEntries()).toHaveLength(entries.length + 2);
		expect(session.sessionManager.getLeafId()).toBe(entries.at(-1)!.id);
		expect(session.messages.map(textOf)).toEqual(["first", "assistant"]);

		ingestReplicaEntry(session, renamed.entry, renamed);
		expect(session.sessionManager.getLeafId()).toBe(title);
		expect(session.messages.map(textOf)).toEqual(["first", "assistant", "batched one", "batched two"]);
		expect(session.sessionManager.getSessionName()).toBe("Named after the batch");
	});
});

describe("applyReplicaEvent", () => {
	function makeView(): {
		ctx: InteractiveModeContext;
		/** Events in the order `handleEvent` was entered (recorded synchronously). */
		dispatched: AgentSessionEvent[];
		/** Hold `handleEvent` for an event type until the deferred resolves. */
		gate: Map<AgentSessionEvent["type"], PromiseWithResolvers<void>>;
	} {
		const dispatched: AgentSessionEvent[] = [];
		const gate = new Map<AgentSessionEvent["type"], PromiseWithResolvers<void>>();
		const ctx = {
			eventController: {
				handleEvent: async (event: AgentSessionEvent) => {
					dispatched.push(event);
					await gate.get(event.type)?.promise;
				},
			},
		} as unknown as InteractiveModeContext;
		return { ctx, dispatched, gate };
	}

	function update(message: AssistantMessage): AgentSessionEvent {
		return {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
		};
	}

	it("synthesizes one message_start before the first orphaned assistant update", async () => {
		const { ctx, dispatched } = makeView();
		const message = createAssistantMessage("partial");

		await applyReplicaEvent(ctx, update(message));
		await applyReplicaEvent(ctx, update(message));

		expect(dispatched.map(e => e.type)).toEqual(["message_start", "message_update", "message_update"]);
		expect(dispatched[0]).toMatchObject({ type: "message_start", message });
	});

	it("does not synthesize a start after a real assistant message_start", async () => {
		const { ctx, dispatched } = makeView();
		const message = createAssistantMessage("streaming");

		await applyReplicaEvent(ctx, { type: "message_start", message });
		await applyReplicaEvent(ctx, update(message));

		expect(dispatched.map(e => e.type)).toEqual(["message_start", "message_update"]);
	});

	it("re-synthesizes after the stream ends and after a new snapshot", async () => {
		const { ctx, dispatched } = makeView();
		const message = createAssistantMessage("a");

		await applyReplicaEvent(ctx, { type: "message_start", message });
		await applyReplicaEvent(ctx, { type: "message_end", message });
		await applyReplicaEvent(ctx, update(message));
		expect(dispatched.map(e => e.type)).toEqual(["message_start", "message_end", "message_start", "message_update"]);

		dispatched.length = 0;
		resetReplicaEventState(ctx);
		await applyReplicaEvent(ctx, update(message));
		expect(dispatched.map(e => e.type)).toEqual(["message_start", "message_update"]);
	});

	it("keeps stream-sync state per view", async () => {
		const first = makeView();
		const second = makeView();
		const message = createAssistantMessage("a");

		await applyReplicaEvent(first.ctx, { type: "message_start", message });
		await applyReplicaEvent(second.ctx, update(message));

		expect(second.dispatched.map(e => e.type)).toEqual(["message_start", "message_update"]);
	});

	it("dispatches a synthesized start and the update back to back for non-awaited callers", () => {
		const { ctx, dispatched, gate } = makeView();
		const message = createAssistantMessage("partial");
		gate.set("message_start", Promise.withResolvers<void>());

		// Collab discards the helper's promise; a slow start handler must not delay later events.
		void applyReplicaEvent(ctx, update(message));
		void applyReplicaEvent(ctx, { type: "message_end", message });

		expect(dispatched.map(e => e.type)).toEqual(["message_start", "message_update", "message_end"]);
		gate.get("message_start")?.resolve();
	});

	it("keeps a newer stream's sync flag when an older agent_end handler settles late", async () => {
		const { ctx, dispatched, gate } = makeView();
		const message = createAssistantMessage("a");
		const endGate = Promise.withResolvers<void>();
		gate.set("agent_end", endGate);

		await applyReplicaEvent(ctx, { type: "message_start", message });
		const pendingEnd = applyReplicaEvent(ctx, { type: "agent_end", messages: [] });
		await applyReplicaEvent(ctx, { type: "message_start", message });
		endGate.resolve();
		await pendingEnd;
		await applyReplicaEvent(ctx, update(message));

		expect(dispatched.map(e => e.type)).toEqual(["message_start", "agent_end", "message_start", "message_update"]);
	});
});

describe("applyReplicaHostState", () => {
	it("mirrors the host model and thinking onto the agent without persisting entries", () => {
		const { session } = makeLocalSession();
		const hostModel = getBundledModel("anthropic", "claude-opus-4-5");
		if (!hostModel) throw new Error("expected bundled opus model");
		const entriesBefore = session.sessionManager.getEntries().length;

		applyReplicaHostState(session, { model: hostModel, thinkingLevel: ThinkingLevel.High });

		expect(session.agent.state.model?.id).toBe(hostModel.id);
		expect(session.agent.state.thinkingLevel).toBe(ThinkingLevel.High);
		expect(session.agent.state.disableReasoning).toBe(false);
		expect(session.sessionManager.getEntries()).toHaveLength(entriesBefore);
	});

	it("turns reasoning off for the off level and honors an explicit disableReasoning", () => {
		const { session } = makeLocalSession();

		applyReplicaHostState(session, { thinkingLevel: ThinkingLevel.Off });
		expect(session.agent.state.thinkingLevel).toBeUndefined();
		expect(session.agent.state.disableReasoning).toBe(true);
		// No host model in the state leaves the local model alone.
		expect(session.agent.state.model?.id).toBe(model.id);

		applyReplicaHostState(session, { thinkingLevel: ThinkingLevel.Low, disableReasoning: true });
		expect(session.agent.state.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(session.agent.state.disableReasoning).toBe(true);
	});

	it("mirrors the thinking level into the model controls of a passive replica only", () => {
		const passive = makeLocalSession({ passiveReplica: true }).session;
		const ordinary = makeLocalSession().session;
		const entriesBefore = passive.sessionManager.getEntries().length;

		applyReplicaHostState(passive, { thinkingLevel: ThinkingLevel.High });
		applyReplicaHostState(ordinary, { thinkingLevel: ThinkingLevel.High });

		// What the composer, the editor border and the selectors read.
		expect(passive.thinkingLevel).toBe(ThinkingLevel.High);
		expect(passive.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		expect(passive.isAutoThinking).toBe(false);
		expect(passive.sessionManager.getEntries()).toHaveLength(entriesBefore);
		// A collab guest's session keeps its previous behavior: the agent mirrors, the model controls do not.
		expect(ordinary.agent.state.thinkingLevel).toBe(ThinkingLevel.High);
		expect(ordinary.thinkingLevel).not.toBe(ThinkingLevel.High);
	});
});
