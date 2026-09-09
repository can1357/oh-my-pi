import { describe, expect, it } from "bun:test";
import { buildCoordinationAdvisory, composeSpawnAdvisory } from "@oh-my-pi/pi-coding-agent/task";
import type { TaskItem } from "@oh-my-pi/pi-coding-agent/task/types";

// Contract: a multi-sibling spawn with spawn capacity and IRC available draws
// a proactive coordinate-via-irc suggestion.
const item = (): TaskItem => ({ task: "do the thing" });

describe("buildCoordinationAdvisory", () => {
	it("suggests hub coordination for >=2 siblings with capacity and hub messaging enabled", () => {
		const advice = buildCoordinationAdvisory([item(), item()], true, true);
		expect(advice).toBeDefined();
		expect(advice).toContain("`hub`");
	});

	it("stays silent for a single spawn", () => {
		expect(buildCoordinationAdvisory([item()], true, true)).toBeUndefined();
	});

	it("stays silent when irc is unavailable", () => {
		expect(buildCoordinationAdvisory([item(), item()], true, false)).toBeUndefined();
	});

	it("stays silent at max depth (no spawn capacity)", () => {
		expect(buildCoordinationAdvisory([item(), item()], false, true)).toBeUndefined();
	});
});

// Contract: TaskTool.execute composes the specialization nudge with the
// coordination suggestion, gating the latter to the async path (sync siblings
// have already finished). composeSpawnAdvisory is the seam that decision flows
// through, so the gating is pinned here rather than only inside the builders.
describe("composeSpawnAdvisory", () => {
	const worker = (): TaskItem => ({ task: "x" });

	it("joins the specialization tip and the irc coordination suggestion for an async generic fanout", () => {
		const advisory = composeSpawnAdvisory({
			agents: ["task", "task"],
			items: [worker(), worker()],
			depthCapacity: true,
			ircEnabled: true,
			willRunAsync: true,
		});
		expect(advisory).toContain("generic");
		expect(advisory).toContain('`agent: "scout"`');
		expect(advisory).toContain("Coordinate:");
	});

	it("drops the scout example from the specialization tip when scout is unavailable", () => {
		const advisory = composeSpawnAdvisory({
			agents: ["task", "task"],
			items: [worker(), worker()],
			depthCapacity: true,
			ircEnabled: true,
			willRunAsync: true,
			scoutAvailable: false,
		});
		expect(advisory).toContain("generic");
		expect(advisory).not.toContain("scout");
		expect(advisory).toContain("Coordinate:");
	});

	it("drops the coordination suggestion on the sync path but keeps the specialization tip", () => {
		const advisory = composeSpawnAdvisory({
			agents: ["task", "task"],
			items: [worker(), worker()],
			depthCapacity: true,
			ircEnabled: true,
			willRunAsync: false,
		});
		expect(advisory).toContain("generic");
		expect(advisory).not.toContain("Coordinate:");
	});

	it("omits coordination when irc is unavailable, even async", () => {
		const advisory = composeSpawnAdvisory({
			agents: ["task", "task"],
			items: [worker(), worker()],
			depthCapacity: true,
			ircEnabled: false,
			willRunAsync: true,
		});
		expect(advisory).toContain("generic");
		expect(advisory).not.toContain("Coordinate:");
	});

	it("returns undefined for a single non-generic spawn", () => {
		expect(
			composeSpawnAdvisory({
				agents: ["reviewer"],
				items: [worker()],
				depthCapacity: true,
				ircEnabled: true,
				willRunAsync: true,
			}),
		).toBeUndefined();
	});

	it("returns undefined at max depth (no spawn capacity)", () => {
		expect(
			composeSpawnAdvisory({
				agents: ["task", "task"],
				items: [worker(), worker()],
				depthCapacity: false,
				ircEnabled: true,
				willRunAsync: true,
			}),
		).toBeUndefined();
	});
});
