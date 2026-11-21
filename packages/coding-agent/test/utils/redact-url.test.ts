import { describe, expect, it } from "bun:test";
import { redactUrlForLog } from "@oh-my-pi/pi-coding-agent/utils/redact-url";

describe("redactUrlForLog", () => {
	it("redacts credential-bearing query params but keeps the rest", () => {
		const redacted = redactUrlForLog("https://mcp.exa.ai/mcp?exaApiKey=sk-secret-123&foo=bar");
		expect(redacted).not.toContain("sk-secret-123");
		expect(redacted).toContain("foo=bar");
		expect(redacted).toContain("https://mcp.exa.ai/mcp");
	});

	it("drops the query string and fragment entirely for unparseable URLs", () => {
		expect(redactUrlForLog("not a url?apiKey=zzz")).toBe("not a url");
		expect(redactUrlForLog("not a url#t=zzz")).toBe("not a url");
	});

	it("strips URL userinfo, including from unparseable URLs", () => {
		const redacted = redactUrlForLog("http://reviewer:topsecret@127.0.0.1:11434/v1");
		expect(redacted).not.toContain("topsecret");
		expect(redacted).not.toContain("reviewer");
		expect(redacted).toContain("127.0.0.1:11434/v1");
		expect(redactUrlForLog("http://user:pw@exa mple?x=1")).toBe("http://exa mple");
	});
});
