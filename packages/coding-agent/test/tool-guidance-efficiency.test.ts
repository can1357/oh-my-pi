import { describe, expect, test } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import bashPrompt from "../src/prompts/tools/bash.md" with { type: "text" };
import globPrompt from "../src/prompts/tools/glob.md" with { type: "text" };
import grepPrompt from "../src/prompts/tools/grep.md" with { type: "text" };

const baseFlags = {
	asyncEnabled: true,
	autoBackgroundEnabled: true,
	autoBackgroundThresholdSeconds: 60,
	hasAstEdit: true,
	hasAstGrep: true,
	hasEval: true,
	hasGlob: true,
	hasGrep: true,
	hasLaunch: true,
	hasRead: true,
	hasShellBuiltins: true,
	isWindows: false,
};
const bash = prompt.render(bashPrompt, baseFlags);
const glob = prompt.render(globPrompt);
const grep = prompt.render(grepPrompt);

describe("tool guidance efficiency", () => {
	test("keeps the corrected guidance smaller than the previous prompt set", () => {
		expect(bash.length + grep.length + glob.length).toBeLessThan(3_050);
	});
	test("steers sqlite3 shell-outs to read when the read tool is active", () => {
		// Routing contract, not a token literal: every sqlite3 mention must
		// prohibit the shell-out and redirect to read, so an inverted
		// "use sqlite3" guidance fails instead of passing.
		const mentions = bash.split("\n").filter(line => line.includes("sqlite3"));
		expect(mentions.length).toBeGreaterThan(0);
		for (const line of mentions) {
			expect(line).toMatch(/NEVER/);
			expect(line).toMatch(/`read`/);
		}
		const withoutRead = prompt.render(bashPrompt, { ...baseFlags, hasRead: false });
		expect(withoutRead).not.toContain("sqlite3");
	});
});
