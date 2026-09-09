import { describe, expect, it } from "bun:test";
import {
	formatDebugLogExpandedLines,
	formatDebugLogLine,
	parseDebugLogTimestampMs,
} from "@oh-my-pi/pi-coding-agent/debug/log-formatting";

describe("formatDebugLogLine", () => {
	it("strips ANSI codes and carriage returns", () => {
		const input = "\u001b[31merror\r\u001b[0m";
		const result = formatDebugLogLine(input, 80);
		expect(result).toBe("error");
	});

	it("replaces tabs with spaces", () => {
		const input = "col1\tcol2";
		const result = formatDebugLogLine(input, 80);
		expect(result).toBe("col1   col2");
	});

	it("removes unsafe control characters", () => {
		const input = "ok\u0007bad";
		const result = formatDebugLogLine(input, 80);
		expect(result).toBe("okbad");
	});

	it("truncates long lines", () => {
		const input = "0123456789ABCDEFGHIJ";
		const result = formatDebugLogLine(input, 10);
		expect(Bun.stringWidth(result)).toBeLessThanOrEqual(10);
		expect(result.startsWith("012345")).toBe(true);
	});

	it("wraps expanded log lines without dropping content", () => {
		const input = "0123456789ABCDEFGHIJ";
		const lines = formatDebugLogExpandedLines(input, 6);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(6);
		}
	});

	it("parses timestamp from JSON log lines", () => {
		const input = '{"timestamp":"2026-02-14T12:34:56.000Z","level":"info","message":"ok"}';
		expect(parseDebugLogTimestampMs(input)).toBe(Date.parse("2026-02-14T12:34:56.000Z"));
	});

	it("returns undefined when timestamp is missing or invalid", () => {
		expect(parseDebugLogTimestampMs('{"message":"ok"}')).toBeUndefined();
		expect(parseDebugLogTimestampMs('{"timestamp":"not-a-date"}')).toBeUndefined();
		expect(parseDebugLogTimestampMs("not-json")).toBeUndefined();
	});
});
