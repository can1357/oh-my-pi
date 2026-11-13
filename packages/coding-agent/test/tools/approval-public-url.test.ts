import { describe, expect, it } from "bun:test";
import { isApprovalPublicUrl } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";

// A public URL skips approval; anything reachable only from this machine or network is gated.
describe("isApprovalPublicUrl", () => {
	it.each([
		["https://example.com/docs", true],
		["www.example.com/docs", true],
		["http://8.8.8.8/", true],
		// IPv6 literals stay gated, public ones included.
		["http://[2606:4700::1111]/", false],
		["http://intranet/", false],
		["http://printer.local/", false],
		["http://127.0.0.1:8080/", false],
		// Ranges the egress proxy also refuses: IETF protocol assignments, benchmarking.
		["http://192.0.0.8/", false],
		["http://198.18.0.1/", false],
	])("%s → %p", (url, expected) => {
		expect(isApprovalPublicUrl(url)).toBe(expected);
	});
});
