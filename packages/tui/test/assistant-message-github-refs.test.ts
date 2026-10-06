import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";

// Force OSC 8 on: CI terminals often resolve to a profile without hyperlinks.
const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
const originalHyperlinks = terminalState.hyperlinks;
beforeAll(() => {
	terminalState.hyperlinks = true;
});
afterAll(() => {
	terminalState.hyperlinks = originalHyperlinks;
});

const reply: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "See #12" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

/** Distinct OSC 8 targets in a component's rendered output. */
function linkTargets(component: AssistantMessageComponent): Set<string> {
	const output = component.render(80).join("\n");
	return new Set(Array.from(output.matchAll(/\x1b\]8;;([^\x07]+)\x07/g), match => match[1]!));
}

describe("assistant reply GitHub refs", () => {
	it("keeps each reply on its own session repo across invalidation", () => {
		const alphaSession: { repo?: string } = {};
		const alpha = new AssistantMessageComponent(
			reply,
			false,
			undefined,
			[],
			undefined,
			true,
			undefined,
			false,
			() => alphaSession.repo,
		);
		const beta = new AssistantMessageComponent(
			reply,
			false,
			undefined,
			[],
			undefined,
			true,
			undefined,
			false,
			() => "owner/beta",
		);
		expect(linkTargets(alpha)).toEqual(new Set());
		expect(linkTargets(beta)).toEqual(new Set(["https://github.com/owner/beta/issues/12"]));

		// Alpha's session repo resolves after its first paint; invalidation picks it
		// up without retargeting beta, and beta's invalidation leaves alpha alone.
		alphaSession.repo = "owner/alpha";
		alpha.invalidate();
		beta.invalidate();
		expect(linkTargets(alpha)).toEqual(new Set(["https://github.com/owner/alpha/issues/12"]));
		expect(linkTargets(beta)).toEqual(new Set(["https://github.com/owner/beta/issues/12"]));
	});
});
