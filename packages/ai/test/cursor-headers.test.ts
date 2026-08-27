import { describe, expect, test } from "bun:test";
import {
	buildCursorRunHeaders,
	buildCursorUnaryHeaders,
	sanitizeCursorCallerHeaders,
} from "../src/providers/cursor/headers";

const API_KEY = "ck_test_123";

describe("sanitizeCursorCallerHeaders", () => {
	test("drops pseudo-headers in any casing", () => {
		const sanitized = sanitizeCursorCallerHeaders({
			":authority": "api2.cursor.sh",
			":method": "POST",
			":path": "/agent.v1.AgentService/Run",
		});
		expect(sanitized).toEqual({});
	});

	test("drops HTTP/1 connection headers in any casing", () => {
		const sanitized = sanitizeCursorCallerHeaders({
			Connection: "keep-alive",
			"Keep-Alive": "timeout=5",
			"Transfer-Encoding": "chunked",
			Upgrade: "h2c",
		});
		expect(sanitized).toEqual({});
	});

	test("drops reserved names in any casing, including compression negotiation", () => {
		const sanitized = sanitizeCursorCallerHeaders({
			":path": "/forged",
			Authorization: "Bearer attacker",
			"Connect-Content-Encoding": "gzip",
			"CONNECT-ACCEPT-ENCODING": "gzip",
			"X-Request-Id": "forged-id",
		});
		expect(sanitized).toEqual({});
	});

	test("keeps benign caller headers and lower-cases them", () => {
		const sanitized = sanitizeCursorCallerHeaders({
			"X-Trace-Id": "abc",
			XEnv: "prod",
			"x-extra": "kept",
		});
		expect(sanitized).toEqual({
			"x-trace-id": "abc",
			xenv: "prod",
			"x-extra": "kept",
		});
	});

	test("returns an empty map for undefined und null-like input", () => {
		expect(sanitizeCursorCallerHeaders(undefined)).toEqual({});
	});

	test("single benign header survives a hostile rest", () => {
		const sanitized = sanitizeCursorCallerHeaders({
			connection: "close",
			"x-benign": "value",
			te: "defraggable",
		});
		expect(sanitized).toEqual({ "x-benign": "value" });
	});
});

describe("buildCursorRunHeaders", () => {
	test("carries the full protocol set with caller headers spread first and losing", () => {
		const headers = buildCursorRunHeaders({
			apiKey: API_KEY,
			requestPath: "/agent.v1.AgentService/Run",
			callerHeaders: { "x-trace-id": "abc", Authorization: "Bearer forged" },
			gzipRequest: true,
		});
		expect(headers[":method"]).toBe("POST");
		expect(headers[":path"]).toBe("/agent.v1.AgentService/Run");
		expect(headers["content-type"]).toBe("application/connect+proto");
		expect(headers["connect-protocol-version"]).toBe("1");
		expect(headers.te).toBe("trailers");
		expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
		expect(headers["x-ghost-mode"]).toBe("true");
		expect(headers["x-cursor-client-type"]).toBe("cli");
		// Sanitizer had already removed the forged Authorization before the fixed
		// value won, so no duplicate and no override.
		expect(String(headers.authorization)).toBe(`Bearer ${API_KEY}`);
		// Caller header survives.
		expect(headers["x-trace-id"]).toBe("abc");
	});

	test("always advertises gzip accept and mirrors gzipRequest onto content", () => {
		const on = buildCursorRunHeaders({ apiKey: API_KEY, requestPath: "/r", gzipRequest: true });
		const off = buildCursorRunHeaders({ apiKey: API_KEY, requestPath: "/r", gzipRequest: false });
		expect(on["connect-accept-encoding"]).toBe("gzip");
		expect(on["connect-content-encoding"]).toBe("gzip");
		expect(off["connect-accept-encoding"]).toBe("gzip");
		expect(off["connect-content-encoding"]).toBe(undefined);
	});

	test("carries the wired client version", () => {
		const headers = buildCursorRunHeaders({ apiKey: API_KEY, requestPath: "/r", gzipRequest: false });
		expect(headers["x-cursor-client-version"]).toBe("cli-2026.08.11-e8db854");
	});

	test("issues a fresh x-request-id per call and never lets a caller set it", () => {
		const a = buildCursorRunHeaders({
			apiKey: API_KEY,
			requestPath: "/r",
			gzipRequest: false,
			callerHeaders: { "x-request-id": "stale" },
		});
		const b = buildCursorRunHeaders({ apiKey: API_KEY, requestPath: "/r", gzipRequest: false });
		expect(typeof a["x-request-id"]).toBe("string");
		expect(String(a["x-request-id"]).length).toBeGreaterThan(0);
		expect(a["x-request-id"]).not.toBe("stale");
		expect(a["x-request-id"]).not.toBe(b["x-request-id"]);
	});

	test("caller cannot override authorization via a differently-cased Authorization", () => {
		const headers = buildCursorRunHeaders({
			apiKey: API_KEY,
			requestPath: "/r",
			gzipRequest: false,
			callerHeaders: { AuThOrIzAtIoN: "Bearer evil", "x-cursor-client-version": "cli-1.0.0" },
		});
		expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
		expect(headers["x-cursor-client-version"]).toBe("cli-2026.08.11-e8db854");
	});
});

describe("buildCursorUnaryHeaders", () => {
	test("is the GetUsableModels set with no pseudo or connect-protocol headers", () => {
		const headers = buildCursorUnaryHeaders({ apiKey: API_KEY });
		expect(headers).toEqual({
			"content-type": "application/proto",
			te: "trailers",
			authorization: `Bearer ${API_KEY}`,
			"x-ghost-mode": "true",
			"x-cursor-client-version": "cli-2026.08.11-e8db854",
			"x-cursor-client-type": "cli",
		});
		expect(Object.keys(headers).some(k => k.startsWith(":"))).toBe(false);
		expect("connect-protocol-version" in headers).toBe(false);
	});

	test("honors an explicit clientVersion override", () => {
		const headers = buildCursorUnaryHeaders({ apiKey: API_KEY, clientVersion: "cli-2026.01.01-abc123" });
		expect(headers["x-cursor-client-version"]).toBe("cli-2026.01.01-abc123");
	});
});
