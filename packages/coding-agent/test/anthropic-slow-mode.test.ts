import { beforeEach, describe, expect, it } from "bun:test";
import type { AnthropicSlowModeFailure, AnthropicSlowModeHooks, AnthropicSlowModeSignal, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import { type AnthropicSlowModeController, AnthropicSlowModeLanes } from "../src/session/anthropic-slow-mode";
import { createSettingsAwareStreamFn } from "../src/session/settings-stream-fn";

const LANE = "cred:1";
const OTHER_LANE = "cred:2";
const nowSec = () => Math.floor(Date.now() / 1000);

function signal(overrides: Partial<AnthropicSlowModeSignal>): AnthropicSlowModeSignal {
	return { unifiedLimitClaim: false, overageInUse: false, ...overrides };
}

function wall(resetsAtSec: number, lane = LANE): AnthropicSlowModeFailure {
	return {
		lane,
		httpStatus: 429,
		overloaded: false,
		sentSlow: false,
		waitedMs: 0,
		attempts: 0,
		signal: signal({ offer: "treatment", unifiedResetAtSec: resetsAtSec, unifiedLimitClaim: true }),
	};
}

function slowFailure(overrides: Partial<AnthropicSlowModeFailure>): AnthropicSlowModeFailure {
	return { lane: LANE, httpStatus: 429, overloaded: false, sentSlow: true, waitedMs: 0, attempts: 0, ...overrides };
}

describe("AnthropicSlowModeController", () => {
	let lanes: AnthropicSlowModeLanes;
	let controller: AnthropicSlowModeController;
	let notices: string[];
	beforeEach(() => {
		lanes = new AnthropicSlowModeLanes();
		controller = lanes.lane(LANE);
		notices = [];
	});
	const hooks = (canAutoAccept?: () => boolean | Promise<boolean>) =>
		lanes.hooks({ canAutoAccept, notify: (_level, message) => notices.push(message) });

	it("auto-accepts a treatment offer at the session-limit wall and resends immediately", async () => {
		const resetsAt = nowSec() + 3_600;
		const retry = await hooks().onFailure(wall(resetsAt));

		expect(retry).toEqual({ delayMs: 0, capacityWait: false });
		expect(controller.isActive()).toBe(true);
		expect(controller.activeResetsAtSec()).toBe(resetsAt);
		expect(notices[0]).toContain("continuing at lower priority");
	});

	it("keeps each Claude account's lane separate", async () => {
		await hooks().onFailure(wall(nowSec() + 3_600, LANE));
		expect(hooks().isActive(LANE)).toBe(true);
		expect(hooks().isActive(OTHER_LANE)).toBe(false);

		// The other account's terminal status must not end this account's lane.
		await hooks().onFailure(slowFailure({ lane: OTHER_LANE, signal: signal({ status: "weekly_limit" }) }));
		expect(hooks().isActive(LANE)).toBe(true);
	});

	it("does not take the lane for a control-arm account or when the sibling gate declines", async () => {
		const resetsAt = nowSec() + 3_600;
		const control = wall(resetsAt);
		control.signal = signal({ offer: "control", unifiedResetAtSec: resetsAt, unifiedLimitClaim: true });
		expect(await hooks().onFailure(control)).toBeUndefined();

		expect(await hooks(() => false).onFailure(wall(resetsAt))).toBeUndefined();
		expect(controller.isActive()).toBe(false);
		// The declined offer is still remembered, so `/slow on` can take it right away.
		expect(controller.accept()).toEqual({ kind: "available", resetsAtSec: resetsAt, resume: false });
		expect(controller.isActive()).toBe(true);
	});

	it("resends with the slow header when a concurrent request wins the auto-accept race", async () => {
		const resetsAt = nowSec() + 3_600;
		const gate = Promise.withResolvers<boolean>();
		const slow = hooks(() => gate.promise).onFailure(wall(resetsAt));
		expect(await hooks().onFailure(wall(resetsAt))).toEqual({ delayMs: 0, capacityWait: false });
		gate.resolve(true);
		expect(await slow).toEqual({ delayMs: 0, capacityWait: false });
	});

	it("paces slot_busy retries on the server interval and ends the lane past max-wait", async () => {
		await hooks().onFailure(wall(nowSec() + 3_600));
		const busy = signal({ status: "slot_busy", retryAfterMs: 10_000, maxWaitMs: 120_000 });

		const retry = await hooks().onFailure(slowFailure({ signal: busy }));
		expect(retry?.capacityWait).toBe(true);
		expect(retry?.delayMs).toBeGreaterThanOrEqual(7_000);
		expect(retry?.delayMs).toBeLessThanOrEqual(13_000);

		expect(await hooks().onFailure(slowFailure({ signal: busy, waitedMs: 120_000, attempts: 6 }))).toBeUndefined();
		expect(controller.isActive()).toBe(false);
		const availability = controller.availability();
		expect(availability.kind).toBe("unavailable");
		expect(availability.kind === "unavailable" && availability.reason).toContain("taking a break");
	});

	it("never schedules a capacity wait past the remaining max-wait budget", async () => {
		await hooks().onFailure(wall(nowSec() + 3_600));
		const busy = signal({ status: "slot_busy", retryAfterMs: 600_000, maxWaitMs: 60_000 });
		const retry = await hooks().onFailure(slowFailure({ signal: busy, waitedMs: 59_000, attempts: 3 }));
		expect(retry).toEqual({ delayMs: 1_000, capacityWait: true });
	});

	it("treats a pre-content 529 as a capacity wait while active", async () => {
		await hooks().onFailure(wall(nowSec() + 3_600));
		const retry = await hooks().onFailure(slowFailure({ httpStatus: 529, overloaded: true }));
		expect(retry?.capacityWait).toBe(true);
		expect(controller.isActive()).toBe(true);
	});

	it("blocks re-entry after weekly and budget exhaustion until their reset", async () => {
		const resetsAt = nowSec() + 3_600;
		await hooks().onFailure(wall(resetsAt));
		const weeklyReset = nowSec() + 86_400;
		await hooks().onFailure(
			slowFailure({ signal: signal({ status: "weekly_limit", weeklyResetAtSec: weeklyReset }) }),
		);
		expect(controller.isActive()).toBe(false);
		const weekly = controller.accept();
		expect(weekly.kind === "unavailable" && weekly.reason).toContain("weekly Claude limit");
		expect(controller.isActive()).toBe(false);

		const budgetLanes = new AnthropicSlowModeLanes();
		const budgetHooks = budgetLanes.hooks({});
		await budgetHooks.onFailure(wall(resetsAt));
		await budgetHooks.onFailure(
			slowFailure({ signal: signal({ status: "budget_exhausted", budgetResetAtSec: nowSec() + 86_400 }) }),
		);
		expect(await budgetHooks.onFailure(wall(resetsAt))).toBeUndefined();
		const budget = budgetLanes.lane(LANE).availability();
		expect(budget.kind === "unavailable" && budget.reason).toContain("allowance is used up");
	});

	it.each(["off", "ineligible"] as const)("drops the offer when the server ends the lane with %s", async status => {
		await hooks().onFailure(wall(nowSec() + 3_600));
		await hooks().onFailure(slowFailure({ signal: signal({ status }) }));
		expect(controller.isActive()).toBe(false);
		expect(controller.accept().kind).toBe("unavailable");
		expect(controller.isActive()).toBe(false);
	});

	it("honors a user stop for the rest of that window but lets /slow on resume it", async () => {
		const resetsAt = nowSec() + 3_600;
		await hooks().onFailure(wall(resetsAt));
		expect(controller.stop("user")).toBe(true);

		expect(await hooks().onFailure(wall(resetsAt))).toBeUndefined();
		expect(controller.isActive()).toBe(false);
		expect(controller.accept()).toEqual({ kind: "available", resetsAtSec: resetsAt, resume: true });
		expect(controller.isActive()).toBe(true);
	});

	it("ends when the 5-hour window rolls over or the accepted reset passes", async () => {
		const resetsAt = nowSec() + 3_600;
		await hooks().onFailure(wall(resetsAt));
		hooks().observe(signal({ status: "active", fiveHourResetAtSec: resetsAt + 18_000 }), LANE);
		expect(controller.isActive()).toBe(false);

		await hooks().onFailure(wall(nowSec() + 7_200));
		expect(controller.isActive(Date.now() + 7_300_000)).toBe(false);
	});

	it("reports the remaining allowance in the status label", async () => {
		await hooks().onFailure(wall(nowSec() + 3_600));
		hooks().observe(signal({ status: "active", budgetUtilization: 0.38 }), LANE);
		expect(controller.statusLabel()).toContain("62% left");
	});
});

describe("createSettingsAwareStreamFn slow-mode wiring", () => {
	const anthropicModel = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" } as Model;
	const openaiModel = { api: "openai-responses", provider: "openai", id: "gpt-5" } as Model;

	function capture(mode: "off" | "auto" | undefined) {
		const calls: Array<{ model: Model; hooks: AnthropicSlowModeHooks | undefined }> = [];
		const lanes = new AnthropicSlowModeLanes();
		const seenLanes: string[] = [];
		const fn = createSettingsAwareStreamFn(
			Settings.isolated(mode === undefined ? {} : { "providers.anthropic.slowMode": mode }),
			((model: Model, _context: unknown, options?: { anthropicSlowMode?: AnthropicSlowModeHooks }) => {
				calls.push({ model, hooks: options?.anthropicSlowMode });
				return undefined as never;
			}) as never,
			{ lanes, onLane: lane => seenLanes.push(lane) },
		);
		fn(anthropicModel, { messages: [] }, undefined);
		fn(openaiModel, { messages: [] }, undefined);
		return { calls, lanes, seenLanes };
	}

	it("attaches hooks only to anthropic requests, and only when the mode is not off", () => {
		const auto = capture("auto").calls;
		expect(auto[0]?.hooks).toBeDefined();
		expect(auto[1]?.hooks).toBeUndefined();

		expect(capture(undefined).calls[0]?.hooks).toBeUndefined();
		expect(capture("off").calls[0]?.hooks).toBeUndefined();
	});

	it("auto switches to the slow lane at the limit and reports the lane", async () => {
		const auto = capture("auto");
		await auto.calls[0]?.hooks?.onFailure(wall(nowSec() + 3_600));
		expect(auto.lanes.lane(LANE).isActive()).toBe(true);
		expect(auto.seenLanes).toEqual([LANE]);
	});
});
