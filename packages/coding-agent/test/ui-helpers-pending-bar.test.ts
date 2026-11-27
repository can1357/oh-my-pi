import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { QueueModel } from "../src/ui/dock/queue";

interface SessionFixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
}

async function createRealSession(): Promise<SessionFixture> {
	const tempDir = TempDir.createSync("@pi-pending-bar-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
	});
	return { tempDir, authStorage, session };
}

function queueCustomSteer(session: AgentSession, chip: string): void {
	session.agent.steer({
		role: "custom",
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: "skill body",
		display: true,
		attribution: "user",
		details: {
			name: "foo",
			path: "/s.md",
			args: "bar",
			lineCount: 1,
			__queueChipText: chip,
		} satisfies SkillPromptDetails,
		timestamp: Date.now(),
	});
}

function contextFor(
	session: AgentSession,
	options?: { focusedAgentId?: string; compactionQueuedMessages?: CompactionQueuedMessage[] },
): { ctx: InteractiveModeContext; queue: QueueModel; dequeued: () => number } {
	const queue = new QueueModel();
	let dequeued = 0;
	const ctx = {
		session,
		viewSession: session,
		focusedAgentId: options?.focusedAgentId,
		compactionQueuedMessages: options?.compactionQueuedMessages ?? [],
		keybindings: { keysFor: () => ["alt+up"] },
		hud: { queue },
		handleDequeue: () => {
			dequeued++;
		},
	} as unknown as InteractiveModeContext;
	return { ctx, queue, dequeued: () => dequeued };
}

describe("UiHelpers.updatePendingMessagesDisplay", () => {
	let fixture: SessionFixture | undefined;

	afterEach(async () => {
		if (!fixture) return;
		await fixture.session.dispose();
		fixture.authStorage.close();
		fixture.tempDir.removeSync();
		fixture = undefined;
	});

	it("lists a queued skill by its compact slash form under Steering", async () => {
		fixture = await createRealSession();
		queueCustomSteer(fixture.session, "/skill:test-skill arg1 arg2");
		const { ctx, queue } = contextFor(fixture.session);
		new UiHelpers(ctx).updatePendingMessagesDisplay();
		expect(queue.groups.peek()).toEqual([{ label: "Steering", messages: ["/skill:test-skill arg1 arg2"] }]);
		expect(queue.dequeueKey.peek()).toBe("alt+up");
	});

	it("empties the band once the queue is cleared, and Edit dequeues", async () => {
		fixture = await createRealSession();
		queueCustomSteer(fixture.session, "/skill:test-skill arg1 arg2");
		const { ctx, queue, dequeued } = contextFor(fixture.session);
		const helpers = new UiHelpers(ctx);
		helpers.updatePendingMessagesDisplay();
		expect(queue.groups.peek()).toHaveLength(1);
		queue.onEdit?.();
		expect(dequeued()).toBe(1);

		fixture.session.clearQueue();
		helpers.updatePendingMessagesDisplay();
		expect(queue.groups.peek()).toEqual([]);
	});

	it("leaves the main session's compaction queue out of a focused subagent view", async () => {
		fixture = await createRealSession();
		const compactionQueuedMessages: CompactionQueuedMessage[] = [{ text: "main compaction", mode: "steer" }];
		const focused = contextFor(fixture.session, { focusedAgentId: "Worker", compactionQueuedMessages });
		new UiHelpers(focused.ctx).updatePendingMessagesDisplay();
		expect(focused.queue.groups.peek()).toEqual([]);

		const main = contextFor(fixture.session, { compactionQueuedMessages });
		new UiHelpers(main.ctx).updatePendingMessagesDisplay();
		expect(main.queue.groups.peek()).toEqual([{ label: "Steering", messages: ["main compaction"] }]);
	});

	it("groups yield follow-ups under one heading, in order", async () => {
		fixture = await createRealSession();
		for (const text of ["inspect types", "run tests", "summarize"]) {
			fixture.session.agent.followUp({ role: "user", content: text, attribution: "user", timestamp: Date.now() });
		}
		const { ctx, queue } = contextFor(fixture.session);
		new UiHelpers(ctx).updatePendingMessagesDisplay();
		expect(queue.groups.peek()).toEqual([
			{ label: "After yield", messages: ["inspect types", "run tests", "summarize"] },
		]);
	});
});
