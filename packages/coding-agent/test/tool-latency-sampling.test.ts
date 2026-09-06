import { expect, it } from "bun:test";
import { measure, parseOptions, summarize } from "../scripts/tool-latency/sampling";

it("reports the even-sample median and nearest-rank p95 without reordering raw samples", () => {
	const raw = Array.from({ length: 20 }, (_, i) => 20 - i);
	expect(summarize(raw)).toEqual({ medianMs: 10.5, p95Ms: 19 });
	expect(raw[0]).toBe(20);
	expect(summarize([])).toEqual({ medianMs: null, p95Ms: null });
});

it("excludes failed observations from warm latency samples and labels their phase", async () => {
	let calls = 0;
	const report = await measure(
		async () => {
			calls++;
			if (calls === 1 || calls === 4) throw new Error("fixture mismatch");
		},
		3,
		1,
	);
	expect(report.firstCallMs).toBeNull();
	expect(report.rawMs).toHaveLength(2);
	expect(report.errors).toEqual(["first call: fixture mismatch", "sample 2: fixture mismatch"]);
});

it("rejects invalid sample budgets and unknown options before starting workloads", () => {
	expect(() => parseOptions(["--runs", "0"])).toThrow("--runs must be an integer");
	expect(() => parseOptions(["--warmups", "1001"])).toThrow("--warmups must be an integer");
	expect(() => parseOptions(["--python"])).toThrow("Missing value");
	expect(() => parseOptions(["--command", "echo"])).toThrow("Unknown option");
});
