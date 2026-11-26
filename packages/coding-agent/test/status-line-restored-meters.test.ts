/**
 * Status line behaviours carried over from the old bar: the jobs badge glances at the freshest live
 * job widget, the cost repaints at a time-based tariff change while idle, and active time is metered
 * per viewed session (a session file swapped in place starts over).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "../src/modes/view-model/status-line/types";
import type { JobWidgetView } from "../src/tools/details/job-widget";
import { disposeStatusLines, statusFacts, statusLine, statusSession, statusText } from "./helpers/session-status-line";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
	vi.useRealTimers();
	setSystemTime();
});

const BARE: StatusLineSettings = {
	preset: "custom",
	leftSegments: [],
	rightSegments: [],
	separator: "none",
	transparent: true,
};

function widget(updatedAt: number, headline: string, values: number[]): JobWidgetView {
	return {
		title: "loadtest",
		state: "live",
		updatedAt,
		headline: { text: headline },
		blocks: [{ kind: "spark", label: "decode", values, min: 0, max: 10, last: String(values.at(-1)) }],
	};
}

describe("jobs badge glance", () => {
	it("appends the freshest live widget's headline and sparkline after the count", () => {
		const running = [{ id: "j1", type: "bash", status: "running", label: "j1", startTime: 0 }];
		const line = statusLine(
			statusSession({
				getAsyncJobSnapshot: () => ({ running }),
				getRunningJobWidgets: () => [
					{ id: "j1", type: "bash", view: widget(1, "old 1 tok/s", [1, 2]) },
					{ id: "j2", type: "bash", view: widget(5, "new 9 tok/s", [0, 5, 10]) },
				],
			}),
			BARE,
		);
		const facts = line.facts();
		expect(facts.jobGlance?.updatedAt).toBe(5);
		const text = statusText(line.settings(), facts);
		expect(text).toContain("1 new 9 tok/s");
		expect(text).toMatch(/[▁▂▃▄▅▆▇█]{3}/);
	});

	it("shows the bare count without a live widget", () => {
		const facts = statusFacts({ jobs: 2 });
		expect(facts.jobGlance).toBeUndefined();
		expect(statusText(BARE, facts)).not.toMatch(/[▁▂▃▄▅▆▇█]/);
	});
});

describe("tariff boundary", () => {
	it("repaints the cost at the next peak/off-peak change while idle", () => {
		vi.useFakeTimers();
		const start = Date.UTC(2026, 0, 5, 7, 59, 0); // a Monday, a minute before the peak window opens
		setSystemTime(start);
		const model = {
			id: "m",
			provider: "p",
			input: ["text"],
			contextWindow: 1000,
			cost: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				timeBased: {
					offPeakMultiplier: 0.5,
					peakWindows: [{ weekdays: [1], startMinute: 8 * 60, endMinute: 17 * 60 }],
				},
			},
		};
		const line = statusLine(statusSession({ state: { messages: [], model }, model }), {
			...BARE,
			leftSegments: ["cost"],
		});
		expect(line.facts().pricingPeriod).toBe("off-peak");
		setSystemTime(start + 60_000);
		vi.advanceTimersByTime(60_000);
		expect(line.facts().pricingPeriod).toBe("peak");
	});
});

describe("active time per session", () => {
	it("keeps each viewed session's meter apart and starts over when the session file changes in place", () => {
		vi.useFakeTimers();
		setSystemTime(2_000_000);
		const main = statusSession({ sessionFile: "/s/main.jsonl" });
		const sub = statusSession({ sessionFile: "/s/sub.jsonl" });
		const line = statusLine(main, BARE);
		line.markActivityStart();
		setSystemTime(2_003_000);
		line.markActivityEnd();
		line.setSession(sub, "sub");
		expect(line.activeMs()).toBe(0);
		line.markActivityStart();
		setSystemTime(2_004_000);
		line.markActivityEnd();
		line.setSession(main);
		expect(line.activeMs()).toBe(3_000);
		(main as unknown as { sessionFile: string }).sessionFile = "/s/resumed.jsonl";
		expect(line.activeMs()).toBe(0);
	});
});
