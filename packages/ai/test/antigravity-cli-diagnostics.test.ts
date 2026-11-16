import { describe, expect, it } from "bun:test";
import {
	DIAGNOSTICS_CAPACITY,
	DIAGNOSTICS_ENV,
	Diagnostics,
	diagnosticsEnabled,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/diagnostics";

function clock(start = 1_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("Diagnostics sampler", () => {
	it("records only finite non-negative samples", () => {
		const diagnostics = new Diagnostics(true);
		diagnostics.record("prompt", Number.NaN);
		diagnostics.record("prompt", Number.POSITIVE_INFINITY);
		diagnostics.record("prompt", -1);
		diagnostics.record("prompt", 0);
		diagnostics.record("prompt", 12.5);
		diagnostics.record("prompt", 4);
		expect(diagnostics.summary().samples).toBe(3);
		expect(diagnostics.generation).toBe(3);
		expect(diagnostics.summary().stages.prompt).toEqual({ count: 3, medianMs: 4, maxMs: 12.5 });
	});

	it("caps samples at 128 and keeps the newest ones", () => {
		const diagnostics = new Diagnostics(true);
		for (let ms = 0; ms < 200; ms++) diagnostics.record("process.start", ms);
		const summary = diagnostics.summary();
		expect(DIAGNOSTICS_CAPACITY).toBe(128);
		expect(summary.samples).toBe(DIAGNOSTICS_CAPACITY);
		expect(summary.capacity).toBe(DIAGNOSTICS_CAPACITY);
		expect(summary.stages["process.start"]).toEqual({ count: 128, medianMs: 135, maxMs: 199 });
		expect(diagnostics.generation).toBe(200);
	});

	it("reports count, median and max per stage and rounds to microseconds", () => {
		const diagnostics = new Diagnostics(true);
		diagnostics.record("session.load", 30);
		diagnostics.record("session.load", 10);
		diagnostics.record("session.load", 20);
		diagnostics.record("session.new", 1.23456);
		const { stages } = diagnostics.summary();
		expect(stages["session.load"]).toEqual({ count: 3, medianMs: 20, maxMs: 30 });
		expect(stages["session.new"]).toEqual({ count: 1, medianMs: 1.235, maxMs: 1.235 });
		expect(Object.keys(stages).sort()).toEqual(["session.load", "session.new"]);
	});

	it("reports the lower middle sample for an even count", () => {
		const diagnostics = new Diagnostics(true);
		diagnostics.record("session.new", 20);
		diagnostics.record("session.new", 10);
		expect(diagnostics.summary().stages["session.new"]).toEqual({ count: 2, medianMs: 10, maxMs: 20 });
	});

	it("records nothing and never reads the clock when disabled", async () => {
		const diagnostics = new Diagnostics(false, () => {
			throw new Error("a disabled sampler must not read the clock");
		});
		expect(diagnostics.enabled).toBe(false);
		diagnostics.record("prompt", 5);
		expect(
			diagnostics.sync("process.start", () => {
				return "started";
			}),
		).toBe("started");
		await expect(diagnostics.measure("prompt", async () => "answered")).resolves.toBe("answered");
		expect(diagnostics.summary()).toEqual({ enabled: false, samples: 0, capacity: 128, stages: {} });
	});

	it("times sync and async work with the injected clock", async () => {
		const fake = clock();
		const diagnostics = new Diagnostics(true, fake.now);
		const created = diagnostics.sync("session.new", () => {
			fake.advance(12.5);
			return "created";
		});
		expect(created).toBe("created");
		await diagnostics.measure("prompt", async () => {
			fake.advance(250);
			return "answered";
		});
		const { stages } = diagnostics.summary();
		expect(stages["session.new"]).toEqual({ count: 1, medianMs: 12.5, maxMs: 12.5 });
		expect(stages.prompt).toEqual({ count: 1, medianMs: 250, maxMs: 250 });
	});

	it("still records a stage when its work fails", async () => {
		const fake = clock();
		const diagnostics = new Diagnostics(true, fake.now);
		expect(() =>
			diagnostics.sync("step.total", () => {
				fake.advance(3);
				throw new Error("sync boom");
			}),
		).toThrow("sync boom");
		await expect(
			diagnostics.measure("step.total", async () => {
				fake.advance(4);
				throw new Error("async boom");
			}),
		).rejects.toThrow("async boom");
		expect(diagnostics.summary().stages["step.total"]).toEqual({ count: 2, medianMs: 3, maxMs: 4 });
	});

	it("records one sample when the callback throws before returning a promise", async () => {
		const fake = clock();
		const diagnostics = new Diagnostics(true, fake.now);
		await expect(
			diagnostics.measure("session.new", () => {
				fake.advance(2);
				throw new Error("sync dispatch boom");
			}),
		).rejects.toThrow("sync dispatch boom");
		expect(diagnostics.summary().stages["session.new"]).toEqual({ count: 1, medianMs: 2, maxMs: 2 });
	});

	it("clears retained samples on reset", () => {
		const diagnostics = new Diagnostics(true);
		diagnostics.record("session.load", 8);
		diagnostics.reset();
		expect(diagnostics.summary().samples).toBe(0);
		expect(diagnostics.summary().stages).toEqual({});
	});

	it("enables itself only for OMP_ACP_DIAGNOSTICS=1", () => {
		expect(DIAGNOSTICS_ENV).toBe("OMP_ACP_DIAGNOSTICS");
		expect(diagnosticsEnabled({ [DIAGNOSTICS_ENV]: "1" })).toBe(true);
		for (const value of [undefined, "", "0", "true", "yes", "2"]) {
			expect(diagnosticsEnabled(value === undefined ? {} : { [DIAGNOSTICS_ENV]: value })).toBe(false);
		}
		const previous = Bun.env[DIAGNOSTICS_ENV];
		try {
			Bun.env[DIAGNOSTICS_ENV] = "1";
			expect(new Diagnostics().enabled).toBe(true);
			Bun.env[DIAGNOSTICS_ENV] = "true";
			expect(new Diagnostics().enabled).toBe(false);
		} finally {
			if (previous === undefined) delete Bun.env[DIAGNOSTICS_ENV];
			else Bun.env[DIAGNOSTICS_ENV] = previous;
		}
	});
});
