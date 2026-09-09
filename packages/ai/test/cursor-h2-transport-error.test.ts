import { describe, expect, it } from "bun:test";
import { ProviderResponseError } from "@oh-my-pi/pi-ai/error";
import { mapH2TransportError } from "@oh-my-pi/pi-ai/providers/cursor";

const BASE_URL = "https://api2.cursor.sh";

describe("mapH2TransportError", () => {
	it("rewrites the opaque bun ALPN failure into an actionable Cursor error", () => {
		const raw = Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
		const mapped = mapH2TransportError(raw, BASE_URL);
		expect(mapped).toBeInstanceOf(ProviderResponseError);
		const err = mapped as ProviderResponseError;
		expect(err.provider).toBe("cursor");
		expect(err.kind).toBe("runtime");
		expect(err.message).toContain(BASE_URL);
		expect(err.message).toContain("ALPN");
		expect(err.message).toContain("providers.cursor.baseUrl");
		expect(err.cause).toBe(raw);
	});

	it("matches the h2-not-supported message case-insensitively", () => {
		const raw = Object.assign(new Error("H2 Is Not Supported"), { code: "ERR_HTTP2_ERROR" });
		expect(mapH2TransportError(raw, BASE_URL)).toBeInstanceOf(ProviderResponseError);
	});

	it("passes through an HTTP/2 error whose message is unrelated to ALPN", () => {
		const raw = Object.assign(new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR"), {
			code: "ERR_HTTP2_ERROR",
		});
		expect(mapH2TransportError(raw, BASE_URL)).toBe(raw);
	});

	it("passes through a non-HTTP/2 error even when it mentions h2", () => {
		const raw = Object.assign(new Error("h2 is not supported"), { code: "ECONNRESET" });
		expect(mapH2TransportError(raw, BASE_URL)).toBe(raw);
	});
});
