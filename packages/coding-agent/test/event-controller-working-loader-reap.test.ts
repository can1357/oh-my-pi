/**
 * EventController idle reap of the working row.
 *
 * The working row and the status-band activity meter are event-driven: a
 * terminal `agent_end` is the only teardown. Two session paths can settle
 * without one — a deferred (`isTerminal: false`) continuation whose wake never
 * arrives, or a dropped/superseded `agent_end` — leaving the row animating
 * against an idle session forever. `#reapWorkingLoaderIfIdle` is the self-heal:
 * while a turn legitimately owns the row the clock waits, and an idle settle
 * with the row still mounted reaps it through the same UI path as a normal end.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Loader } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const REAP_WARNING = "Working row reaped: idle settle with no terminal agent_end";

function createFixture() {
	const sessionState = { isStreaming: false, pendingAsyncWork: false, queued: 0 };
	const ctx = createInteractiveModeContext({
		session: {
			get isStreaming() {
				return sessionState.isStreaming;
			},
			hasPendingAsyncWork: () => sessionState.pendingAsyncWork,
			get queuedMessageCount() {
				return sessionState.queued;
			},
		},
	});
	const disposeChildren = vi.spyOn(ctx.statusContainer, "disposeChildren");
	const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
	const controller = new EventController(ctx);
	return { controller, ctx, sessionState, disposeChildren, markActivityEnd };
}

function mountWorkingLoader(ctx: InteractiveModeContext): { stop: ReturnType<typeof vi.fn> } {
	const loader = { stop: vi.fn() };
	ctx.loadingAnimation = loader as unknown as Loader;
	return loader;
}

const agentStart = { type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>;

describe("EventController working loader idle reap", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("reaps the working row after a deferred settle whose continuation never arrives", async () => {
		const { controller, ctx, sessionState, disposeChildren, markActivityEnd } = createFixture();
		const loader = mountWorkingLoader(ctx);
		const warn = vi.spyOn(logger, "warn");

		sessionState.isStreaming = true;
		await controller.handleEvent(agentStart);
		sessionState.isStreaming = false;
		await controller.handleEvent({
			type: "agent_end",
			messages: [],
			isTerminal: false,
		} as Extract<AgentSessionEvent, { type: "agent_end" }>);

		// A deferred settle is a scheduling pause: the row legitimately stays up
		// until the reap grace elapses.
		expect(ctx.loadingAnimation).toBeDefined();
		expect(loader.stop).not.toHaveBeenCalled();

		vi.advanceTimersByTime(2_000);

		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(disposeChildren).toHaveBeenCalledTimes(1);
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(REAP_WARNING);
	});

	it("keeps the working row while pending async work will wake the session", async () => {
		const { controller, ctx, sessionState } = createFixture();
		const loader = mountWorkingLoader(ctx);
		const warn = vi.spyOn(logger, "warn");

		sessionState.isStreaming = true;
		await controller.handleEvent(agentStart);
		sessionState.isStreaming = false;
		sessionState.pendingAsyncWork = true;
		await controller.handleEvent({
			type: "agent_end",
			messages: [],
			isTerminal: false,
		} as Extract<AgentSessionEvent, { type: "agent_end" }>);

		// Three reap intervals later the row is still owned by the pending wake.
		vi.advanceTimersByTime(6_000);

		expect(loader.stop).not.toHaveBeenCalled();
		expect(ctx.loadingAnimation).toBeDefined();
		expect(warn).not.toHaveBeenCalledWith(REAP_WARNING);
	});

	it("tears the row down once on a terminal settle and disarms the reap clock", async () => {
		const { controller, ctx, sessionState } = createFixture();
		const loader = mountWorkingLoader(ctx);
		const warn = vi.spyOn(logger, "warn");

		sessionState.isStreaming = true;
		await controller.handleEvent(agentStart);
		sessionState.isStreaming = false;
		await controller.handleEvent({ type: "agent_end", messages: [] } as Extract<
			AgentSessionEvent,
			{ type: "agent_end" }
		>);

		// The terminal path owns the teardown; no reap warning is involved.
		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(warn).not.toHaveBeenCalledWith(REAP_WARNING);

		// The idle clock is gone: later ticks neither re-stop nor re-warn.
		vi.advanceTimersByTime(6_000);
		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(warn).not.toHaveBeenCalledWith(REAP_WARNING);
	});
});
