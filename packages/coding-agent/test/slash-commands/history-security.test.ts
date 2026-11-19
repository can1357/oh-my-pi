import { describe, expect, it } from "bun:test";
import { shouldSkipHistory } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";

describe("shouldSkipHistory — security filter for slash command history", () => {
	it("skips /login with a redirect URL argument (contains OAuth code/state)", () => {
		expect(shouldSkipHistory("/login http://localhost:1455/auth/callback?code=abc&state=xyz")).toBe(true);
	});

	it("does not skip /login without arguments (triggers provider selector)", () => {
		expect(shouldSkipHistory("/login")).toBe(false);
	});

	it("skips /login with any argument (provider name or callback — all forms can carry secrets)", () => {
		// parseCallbackInput() accepts redirect URLs, query strings, and raw auth codes.
		// All /login-with-args are skipped to prevent any OAuth secret leakage.
		expect(shouldSkipHistory("/login anthropic")).toBe(true);
		expect(shouldSkipHistory("/login ?code=abc&state=xyz")).toBe(true);
		expect(shouldSkipHistory("/login raw-auth-code-xyz")).toBe(true);
	});

	it("skips /login when colon-separated (parseSlashCommand treats : as separator)", () => {
		// /login:?code=abc&state=xyz — the colon is a valid separator, so the
		// command name is "login" and the args carry the OAuth secret.
		expect(shouldSkipHistory("/login:?code=abc&state=xyz")).toBe(true);
		expect(shouldSkipHistory("/login:auth-code-xyz")).toBe(true);
	});

	it("skips /join with a link argument (carries 32-byte room key and write token)", () => {
		expect(shouldSkipHistory("/join omp://share/abc123def456...")).toBe(true);
		expect(shouldSkipHistory("/join omp:abc123def456...")).toBe(true);
	});

	it("does not skip /join without arguments", () => {
		expect(shouldSkipHistory("/join")).toBe(false);
	});

	it("skips /mcp add with --token flag (contains bearer token)", () => {
		expect(shouldSkipHistory("/mcp add myserver --url http://x --token sk-secret123")).toBe(true);
	});

	it("does not skip /mcp add without --token", () => {
		expect(shouldSkipHistory("/mcp add myserver --url http://x")).toBe(false);
	});

	it("does not skip /mcp without add subcommand", () => {
		expect(shouldSkipHistory("/mcp list")).toBe(false);
		expect(shouldSkipHistory("/mcp reload")).toBe(false);
	});

	it("does not skip ordinary slash commands", () => {
		expect(shouldSkipHistory("/plan do something")).toBe(false);
		expect(shouldSkipHistory("/settings")).toBe(false);
		expect(shouldSkipHistory("/btw what is this")).toBe(false);
		expect(shouldSkipHistory("/model claude")).toBe(false);
	});

	it("returns false for non-slash text", () => {
		expect(shouldSkipHistory("just a prompt")).toBe(false);
		expect(shouldSkipHistory("")).toBe(false);
	});
});
