/**
 * Text typed while a compaction owns the history is parked in
 * `ctx.compactionQueuedMessages` by the input controller and reported to the
 * user as "queued for after compaction". `CommandController.executeCompaction()`
 * drains that queue when `/compact` finishes, and `auto_compaction_end` drains
 * it for the automatic passes.
 *
 * A model-requested compaction (the `compact` tool) has neither: it runs
 * detached after the turn settles and emits no lifecycle event, so the parked
 * message had no flush site at all and waited for an unrelated later turn. The
 * terminal `agent_end` is that site.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	settings.set("display.smoothStreaming", false);
});

function createFixture(sessionState: { isStreaming: boolean; isCompacting: boolean }) {
	const ctx = createInteractiveModeContext({
		session: {
			get isStreaming() {
				return sessionState.isStreaming;
			},
			get isCompacting() {
				return sessionState.isCompacting;
			},
		},
	});
	const flushCompactionQueue = vi.spyOn(ctx, "flushCompactionQueue");
	return { ctx, controller: new EventController(ctx), flushCompactionQueue };
}

const terminalEnd = { type: "agent_end", messages: [] } as unknown as Extract<AgentSessionEvent, { type: "agent_end" }>;

describe("EventController drains the compaction queue at a terminal end", () => {
	it("flushes when a requested compaction has finished", async () => {
		const sessionState = { isStreaming: false, isCompacting: false };
		const { controller, flushCompactionQueue } = createFixture(sessionState);

		await controller.handleEvent(terminalEnd);

		expect(flushCompactionQueue).toHaveBeenCalledTimes(1);
		expect(flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	it("does not flush while a compaction is still running", async () => {
		// A terminal end can be emitted mid-pass (the pass's own `abort()` zeroes
		// the prompt count). Draining then would dispatch the queued text against
		// the history being replaced — the race the queue exists to avoid.
		const sessionState = { isStreaming: false, isCompacting: true };
		const { controller, flushCompactionQueue } = createFixture(sessionState);

		await controller.handleEvent(terminalEnd);

		expect(flushCompactionQueue).not.toHaveBeenCalled();
	});

	it("does not flush at a non-terminal settle", async () => {
		// `isTerminal: false` means a successor turn is still owed, so the queue
		// keeps waiting rather than interleaving with it.
		const sessionState = { isStreaming: false, isCompacting: false };
		const { controller, flushCompactionQueue } = createFixture(sessionState);

		await controller.handleEvent({ type: "agent_end", isTerminal: false } as Extract<
			AgentSessionEvent,
			{ type: "agent_end" }
		>);

		expect(flushCompactionQueue).not.toHaveBeenCalled();
	});
});

describe("EventController labels a requested compaction's cancellation", () => {
	it("names the agent's own operation instead of automatic maintenance", async () => {
		// Esc during the summary, or a `session_before_compact` hook declining,
		// emits `action: "requested"` with `aborted: true`. With no case for it,
		// the cancellation fell through to the automatic threshold branch and told
		// the user "Auto context-full maintenance cancelled" for an operation the
		// agent requested.
		const sessionState = { isStreaming: false, isCompacting: false };
		const { ctx, controller } = createFixture(sessionState);

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "requested",
			result: undefined,
			aborted: true,
			willRetry: false,
		} as unknown as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>);

		const statuses = (ctx.showStatus as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(call =>
			String(call[0]),
		);
		expect(statuses).toContain("Agent-requested compaction cancelled");
		expect(statuses.some(status => status.startsWith("Auto"))).toBe(false);
	});
});
