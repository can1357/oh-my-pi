/**
 * Contract: `AgentSession` emits a `queue_update` session event — the RPC-facing
 * `{ steering, followUp }` snapshot mirrored by `getQueuedMessages()` — whenever
 * the displayable steering/follow-up queue actually changes, and never repeats
 * an unchanged snapshot. The agent's queue mutators (enqueue, dequeue on
 * delivery, remove, clear/restore) all funnel through one internal signal;
 * these tests prove the externally observable coalescing contract that signal
 * produces, not the internal wiring.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

interface QueueSnapshot {
	steering: readonly string[];
	followUp: readonly string[];
}

describe("AgentSession queue_update events", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-queue-update-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function createSession(responses: MockResponse[], followUpMode: "all" | "one-at-a-time" = "one-at-a-time") {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
			followUpMode,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		return session;
	}

	function collectQueueUpdates(target: AgentSession): QueueSnapshot[] {
		const updates: QueueSnapshot[] = [];
		target.subscribe(event => {
			if (event.type === "queue_update")
				updates.push({ steering: [...event.steering], followUp: [...event.followUp] });
		});
		return updates;
	}

	it("shows both queued follow-ups, then one after removal, then empty after delivery", async () => {
		const target = createSession([{ content: ["turn one"] }, { content: ["turn two"] }], "all");
		const updates = collectQueueUpdates(target);

		let streamingAtInject: boolean | undefined;
		let removedFirst: boolean | undefined;
		target.agent.setOnBeforeYield(async () => {
			if (streamingAtInject !== undefined) return;
			// The session is still mid-prompt here (the yield boundary of the first
			// turn), so both follow-ups are queued while genuinely streaming.
			streamingAtInject = target.isStreaming;
			await target.followUp("first");
			await target.followUp("second");
			removedFirst = target.removeQueuedMessage("first", "followUp");
		});

		await target.prompt("hello");

		expect(streamingAtInject).toBe(true);
		expect(removedFirst).toBe(true);
		// Enqueue both, then the removal, then the forced continuation turn
		// dequeuing "second" for delivery — each step is one distinct snapshot.
		expect(updates.map(update => update.followUp)).toEqual([["first"], ["first", "second"], ["second"], []]);
		expect(updates.every(update => update.steering.length === 0)).toBe(true);

		// get_state's RPC-facing snapshot is exactly the last emitted event.
		expect(target.getQueuedMessages()).toEqual(updates.at(-1)!);

		// No duplicate identical consecutive events.
		for (let i = 1; i < updates.length; i++) {
			expect(updates[i]).not.toEqual(updates[i - 1]);
		}
	});

	it("never re-emits when a mutation leaves the displayable queue unchanged", async () => {
		const target = createSession([{ content: ["turn one"] }]);
		const updates = collectQueueUpdates(target);

		await target.steer("kept");
		// Clearing an already-empty follow-up queue does not touch the
		// displayable snapshot (steering still holds "kept"); it must not emit.
		target.agent.clearFollowUpQueue();

		expect(updates).toEqual([{ steering: ["kept"], followUp: [] }]);
	});

	it("satisfies the snapshot-string-removal invariant for every queued chip", async () => {
		const target = createSession([{ content: ["turn one"] }, { content: ["turn two"] }]);

		let snapshot: QueueSnapshot | undefined;
		const removed: boolean[] = [];
		let remaining: QueueSnapshot | undefined;
		target.agent.setOnBeforeYield(async () => {
			if (snapshot) return;
			// Queue while the turn is still running: an idle session delivers a
			// steer immediately, so nothing would stay queued to snapshot.
			await target.steer("steer one");
			await target.followUp("follow one");
			await target.followUp("follow two");
			const current = target.getQueuedMessages();
			snapshot = current;
			for (const text of current.steering) removed.push(target.removeQueuedMessage(text, "steering"));
			for (const text of current.followUp) removed.push(target.removeQueuedMessage(text, "followUp"));
			remaining = target.getQueuedMessages();
		});

		await target.prompt("hello");

		expect(snapshot).toEqual({ steering: ["steer one"], followUp: ["follow one", "follow two"] });
		expect(removed).toEqual([true, true, true]);
		expect(remaining).toEqual({ steering: [], followUp: [] });
	});
});
