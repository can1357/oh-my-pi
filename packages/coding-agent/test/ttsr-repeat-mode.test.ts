import { describe, expect, it } from "bun:test";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { TtsrManager, type TtsrMatchContext } from "@oh-my-pi/pi-coding-agent/export/ttsr";

const TEXT: TtsrMatchContext = { source: "text" };

/** A probe-check rule loaded from markdown, so the frontmatter parse is part of the path under test. */
function probeRule(frontmatter: string) {
	const content = String.raw`---
condition: '(?i)\bprobes?\b'
scope: text
${frontmatter}---
Check the claim before continuing.
`;
	return buildRuleFromMarkdown(
		"probe-check.md",
		content,
		"probe-check.md",
		createSourceMeta("test", "probe-check.md", "project"),
	);
}

/** One completed assistant text: stream it, record what fired, then advance the turn counter. */
function completeTurn(manager: TtsrManager, text: string): string[] {
	manager.resetBuffer();
	const matches = manager.checkDelta(text, TEXT, { final: true });
	manager.markInjected(matches);
	manager.incrementMessageCount();
	return matches.map(rule => rule.name);
}

describe("TTSR per-rule repeatMode", () => {
	it("re-triggers a repeatMode: always rule on every matching turn", () => {
		const manager = new TtsrManager({ repeatMode: "once" });
		manager.addRule(probeRule("repeatMode: always\n"));

		expect(completeTurn(manager, "I'll probe the endpoint.")).toEqual(["probe-check"]);
		expect(completeTurn(manager, "Probe results look fine.")).toEqual(["probe-check"]);
		expect(completeTurn(manager, "Two probes came back empty.")).toEqual(["probe-check"]);
		expect(completeTurn(manager, "The build is green.")).toEqual([]);
	});

	it("keeps the global once policy for rules without a repeatMode", () => {
		const manager = new TtsrManager({ repeatMode: "once" });
		manager.addRule(probeRule(""));

		expect(completeTurn(manager, "I'll probe the endpoint.")).toEqual(["probe-check"]);
		expect(completeTurn(manager, "I'll probe again.")).toEqual([]);
	});

	it("applies a rule's own after-gap window even when the global policy is once", () => {
		const manager = new TtsrManager({ repeatMode: "once", repeatGap: 3 });
		manager.addRule(probeRule("repeatMode: after-gap\n"));

		expect(completeTurn(manager, "I'll probe the endpoint.")).toEqual(["probe-check"]);
		expect(completeTurn(manager, "Probe again.")).toEqual([]);
		expect(completeTurn(manager, "Probe once more.")).toEqual([]);
		expect(completeTurn(manager, "And probe a third time.")).toEqual(["probe-check"]);
	});
});
