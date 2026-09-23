import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createMCPTimeout, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { logger } from "@oh-my-pi/pi-utils";

const ORIGINAL_TIMEOUT = process.env.OMP_MCP_TIMEOUT_MS;

afterEach(() => {
	if (ORIGINAL_TIMEOUT === undefined) {
		delete process.env.OMP_MCP_TIMEOUT_MS;
	} else {
		process.env.OMP_MCP_TIMEOUT_MS = ORIGINAL_TIMEOUT;
	}
});

describe("MCP timeout configuration", () => {
	test("uses the default timeout when no config or env override is set", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs()).toBe(30_000);
	});

	test("uses per-server timeout when env override is unset", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
	});

	test("allows the env override to disable MCP client-side timeouts", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "0";

		const timeout = resolveMCPTimeoutMs(30_000);
		expect(timeout).toBe(0);
		expect(isMCPTimeoutEnabled(timeout)).toBe(false);
	});

	test("allows the env override to set one timeout for every server", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "180000";

		expect(resolveMCPTimeoutMs(30_000)).toBe(180_000);
	});

	test("rejects negative env values and warns, falling back to the default", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "-1";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("OMP_MCP_TIMEOUT_MS");
		} finally {
			warn.mockRestore();
		}
	});

	test("rejects non-numeric env values and falls back to the default", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "not-a-number";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs()).toBe(30_000);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("createMCPTimeout abort-source tracking", () => {
	test("reports timedOut when the timer fires", async () => {
		const op = createMCPTimeout(50);
		try {
			expect(op.signal).toBeDefined();
			expect(op.timedOut()).toBe(false);
			// Wait for the timer to fire
			await Bun.sleep(60);
			expect(op.timedOut()).toBe(true);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(true);
		} finally {
			op.clear();
		}
	});
	test("preserves timeout when caller signal aborts after the timer fires", async () => {
		const caller = new AbortController();
		const op = createMCPTimeout(50, caller.signal);
		try {
			await Bun.sleep(60);
			// Timer fired, caller hasn't aborted yet
			expect(op.timedOut()).toBe(true);
			// Now the caller aborts — simulating the race where the caller's
			// signal becomes aborted after the timer but before the catch block
			caller.abort();
			expect(op.timedOut()).toBe(true);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(true);
			// A SyntaxError from a truncated body read is also a timeout consequence
			expect(op.isTimeoutAbort(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
		} finally {
			op.clear();
		}
	});

	test("does not treat a SyntaxError as timeout when the signal is not aborted", () => {
		const op = createMCPTimeout(10_000);
		try {
			// Timer hasn't fired, signal not aborted — a SyntaxError is a
			// genuinely malformed response, not a timeout
			expect(op.isTimeoutAbort(new SyntaxError("Unexpected token"))).toBe(false);
			expect(op.timedOut()).toBe(false);
		} finally {
			op.clear();
		}
	});

	test("reports not timed out when only the caller aborts", () => {
		const caller = new AbortController();
		const op = createMCPTimeout(10_000, caller.signal);
		try {
			caller.abort();
			expect(op.timedOut()).toBe(false);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
		} finally {
			op.clear();
		}
	});

	test("immediately aborts when the caller signal is already aborted", () => {
		const caller = new AbortController();
		caller.abort();
		const op = createMCPTimeout(10_000, caller.signal);
		try {
			// Timer never started; not a timeout
			expect(op.timedOut()).toBe(false);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
			expect(op.signal?.aborted).toBe(true);
		} finally {
			op.clear();
		}
	});

	test("disabled timeout never reports timed out", () => {
		const op = createMCPTimeout(0);
		try {
			expect(op.timedOut()).toBe(false);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
		} finally {
			op.clear();
		}
	});

	test("does not report timeout when caller aborts before the timer fires", async () => {
		const caller = new AbortController();
		const op = createMCPTimeout(10_000, caller.signal);
		try {
			// Caller aborts first — timer is cancelled, not a timeout
			caller.abort();
			expect(op.timedOut()).toBe(false);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
			// Even if we wait past the timeoutMs, the timer was cancelled and
			// must not fire
			await Bun.sleep(20);
			expect(op.timedOut()).toBe(false);
		} finally {
			op.clear();
		}
	});
});
