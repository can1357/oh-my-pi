import { afterEach, describe, expect, it } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { resetActiveRulesForTests, setActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { InternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { RuleProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/rule-protocol";

function makeRule(name: string, content: string): Rule {
	return {
		name,
		path: `/tmp/${name}.md`,
		content,
		_source: { provider: "test", providerName: "test", path: `/tmp/${name}.md`, level: "user" },
	};
}

function ruleUrl(name: string): InternalUrl {
	return Object.assign(new URL(`rule://${name}`), { rawHost: name }) as InternalUrl;
}

describe("RuleProtocolHandler", () => {
	afterEach(() => {
		resetActiveRulesForTests();
	});

	it("resolves a rule scoped only to a subagent that never touched the main session's global snapshot", async () => {
		// The main session's rule bucketing (setActiveRules) never included this
		// rule because it is `agents: [scout]`-scoped; only the scout's own
		// context carries it. A subagent must still be able to read its own
		// `rule://<name>` even though the process-global snapshot excludes it —
		// see PR #10624 (persisted-agents/sdk.ts scoping).
		setActiveRules([makeRule("main-only", "main body")]);
		const scoutRules = [makeRule("scout-only", "scout body")];

		const resource = await new RuleProtocolHandler().resolve(ruleUrl("scout-only"), { rules: scoutRules });
		expect(resource.content.trim()).toBe("scout body");
	});

	it("does not leak a subagent's scoped rule into a caller resolving without that context", async () => {
		setActiveRules([makeRule("main-only", "main body")]);

		await expect(new RuleProtocolHandler().resolve(ruleUrl("scout-only"))).rejects.toThrow("Unknown rule");
	});

	it("falls back to the process-global snapshot when no context rules are supplied", async () => {
		setActiveRules([makeRule("legacy", "legacy body")]);

		const resource = await new RuleProtocolHandler().resolve(ruleUrl("legacy"));
		expect(resource.content.trim()).toBe("legacy body");
	});

	it("completes against the caller's scoped rule set instead of the global snapshot", async () => {
		setActiveRules([makeRule("main-only", "main body")]);
		const scoutRules = [makeRule("scout-only", "scout body")];

		const completions = await new RuleProtocolHandler().complete(undefined, { rules: scoutRules });
		expect(completions.map(c => c.value)).toEqual(["scout-only"]);
	});
});
