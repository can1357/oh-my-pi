import { describe, expect, it } from "bun:test";
import { isUnsupportedProxyError, unsupportedProxyMessage } from "../../src/utils/fetch-timeout";

describe("isUnsupportedProxyError", () => {
	it("matches Bun's UnsupportedProxyProtocol rejection and nothing else", () => {
		expect(isUnsupportedProxyError(new Error('UnsupportedProxyProtocol fetching "https://x"'))).toBe(true);
		expect(isUnsupportedProxyError(new Error("ConnectionRefused"))).toBe(false);
		expect(isUnsupportedProxyError("UnsupportedProxyProtocol")).toBe(false);
	});
});

describe("unsupportedProxyMessage", () => {
	it("names the proxy env var whose scheme Bun's fetch cannot use", () => {
		const message = unsupportedProxyMessage({
			HTTPS_PROXY: "socks5h://127.0.0.1:1080",
			NO_PROXY: "localhost",
		});
		expect(message).toContain("HTTPS_PROXY=socks5h://127.0.0.1:1080");
		expect(message).toMatch(/http:\/\//);
	});

	it("does not flag http(s) proxy vars as offending", () => {
		const message = unsupportedProxyMessage({ HTTP_PROXY: "http://127.0.0.1:8080" });
		expect(message).not.toContain("offending");
		expect(message).toContain("Only http:// and https:// proxies are supported");
	});
});
