import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PYTHON_MAX_RSS_MB,
	formatKernelRssRecycleAnnotation,
	kernelRssExceedsLimit,
	normalizeMaxRssMb,
	parsePsRssKb,
	readProcessRssKb,
} from "../../src/eval/process-rss";

describe("parsePsRssKb", () => {
	test("parses spaced ps rss output as kilobytes", () => {
		expect(parsePsRssKb("  12345\n")).toBe(12345);
	});

	test("rejects empty or non-numeric output", () => {
		expect(parsePsRssKb("")).toBeUndefined();
		expect(parsePsRssKb("RSS\n")).toBeUndefined();
		expect(parsePsRssKb("  \n")).toBeUndefined();
	});
});

describe("normalizeMaxRssMb", () => {
	test("defaults when unset", () => {
		expect(normalizeMaxRssMb(undefined)).toBe(DEFAULT_PYTHON_MAX_RSS_MB);
	});

	test("treats non-positive values as disabled", () => {
		expect(normalizeMaxRssMb(0)).toBe(0);
		expect(normalizeMaxRssMb(-8)).toBe(0);
	});

	test("floors fractional megabytes", () => {
		expect(normalizeMaxRssMb(1024.9)).toBe(1024);
	});
});

describe("kernelRssExceedsLimit", () => {
	test("does not recycle when the cap is disabled", () => {
		expect(kernelRssExceedsLimit(50_000_000, 0)).toBe(false);
	});

	test("does not recycle when rss is unknown", () => {
		expect(kernelRssExceedsLimit(undefined, 1024)).toBe(false);
	});

	test("recycles only once rss is strictly above the cap", () => {
		const capKb = 1024 * 1024;
		expect(kernelRssExceedsLimit(capKb, 1024)).toBe(false);
		expect(kernelRssExceedsLimit(capKb + 1, 1024)).toBe(true);
	});
});

describe("formatKernelRssRecycleAnnotation", () => {
	test("names the setting and observed size", () => {
		expect(formatKernelRssRecycleAnnotation(1536, 1024)).toContain("python.maxRssMb=1024");
		expect(formatKernelRssRecycleAnnotation(1536, 1024)).toContain("1536MB");
	});
});

describe("readProcessRssKb", () => {
	test("reads a live pid on posix", async () => {
		if (process.platform === "win32") return;
		const rssKb = await readProcessRssKb(process.pid);
		expect(rssKb).toBeGreaterThan(0);
	});
});
