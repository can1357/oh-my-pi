import { describe, expect, it } from "bun:test";
import { composeAppendPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

/**
 * The generated blocks that precede a user's append prompt end with the MCP
 * server instructions section, which declares its text server-controlled and
 * unverified. The user's own instructions must not read as part of it.
 */
const MCP_SECTION = [
	"## MCP Server Instructions",
	"",
	"The following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
	"",
	"### codegraph",
	"# Codegraph — available (per-project; pass projectPath)",
].join("\n");

describe("composeAppendPrompt", () => {
	it("gives a user append prompt its own heading after generated blocks", () => {
		const composed = composeAppendPrompt(["memory guidance", MCP_SECTION], "Reply in English.");
		expect(composed).toBeDefined();

		const boundary = composed!.indexOf("\n## User Instructions\n\n");
		expect(boundary).toBeGreaterThan(composed!.indexOf("### codegraph"));
		expect(composed!.slice(0, boundary)).not.toContain("Reply in English.");
		expect(composed!.slice(boundary).endsWith("Reply in English.")).toBe(true);
	});

	it("preserves Markdown hard breaks and literal content when framing user instructions", () => {
		const generated = "## MCP Server Instructions\n\nKeep this hard break.  \nNext line.\n\n\n<server>";
		const user = "Keep this hard break.  \nNext line.\n\n\n| left | right |\n{{literal}} <user> & value\n";
		const composed = composeAppendPrompt([generated], user)!;
		expect(composed.startsWith(`${generated}\n\n## User Instructions\n\n`)).toBe(true);
		expect(composed.slice(-user.length)).toBe(user);
	});

	it("leaves a lone user append prompt untouched", () => {
		expect(composeAppendPrompt([], "Reply in English.")).toBe("Reply in English.");
	});

	it("leaves generated blocks untouched without a user append", () => {
		expect(composeAppendPrompt(["memory guidance", MCP_SECTION])).toBe(`memory guidance\n\n${MCP_SECTION}`);
		expect(composeAppendPrompt([])).toBeUndefined();
	});

	it("ignores a whitespace-only user append", () => {
		expect(composeAppendPrompt(["memory guidance"], "\n  \n")).toBe("memory guidance");
	});
});
