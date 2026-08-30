/**
 * `TtsrManager.reconfigure` applies reloaded runtime settings (enabled,
 * contextMode, interruptMode, repeatMode, repeatGap) to a live manager on an
 * in-session `/refresh settings` WITHOUT tearing it down: registered rules and
 * injection state survive, so an already-injected rule stays injected. Before
 * this, a settings refresh only forwarded the bucketing flags and the runtime
 * behavior stayed frozen at construction until restart.
 */
import { describe, expect, it } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { TtsrSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

function conditionRule(name: string): Rule {
	return {
		name,
		path: `/tmp/${name}.md`,
		content: "body",
		condition: ["TRIGGER"],
		_source: { provider: "native", providerName: "native", path: `/tmp/${name}.md`, level: "user" },
	} as Rule;
}

function fullSettings(overrides: Partial<TtsrSettings> = {}): TtsrSettings {
	return {
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
		...overrides,
	};
}

describe("TtsrManager.reconfigure", () => {
	it("applies reloaded runtime settings while preserving registered rules and injection state", () => {
		const mgr = new TtsrManager(
			fullSettings({ contextMode: "discard", interruptMode: "always", repeatMode: "once" }),
		);
		mgr.addRule(conditionRule("rule-a"));
		mgr.markInjectedByNames(["rule-a"]);
		expect(mgr.getSettings().contextMode).toBe("discard");
		expect(mgr.getInjectedRuleNames()).toContain("rule-a");

		// Reloaded config changes the runtime knobs.
		mgr.reconfigure({ contextMode: "keep", interruptMode: "tool-only", repeatMode: "after-gap", repeatGap: 3 });

		// New runtime settings are live...
		const settings = mgr.getSettings();
		expect(settings.contextMode).toBe("keep");
		expect(settings.interruptMode).toBe("tool-only");
		expect(settings.repeatMode).toBe("after-gap");
		expect(settings.repeatGap).toBe(3);
		// ...and the registered rule + its injection record survived the reconfigure.
		expect(mgr.getRules().map(r => r.name)).toContain("rule-a");
		expect(mgr.getInjectedRuleNames()).toContain("rule-a");
	});

	it("applies a reloaded enabled flip without dropping registered rules", () => {
		const mgr = new TtsrManager(fullSettings({ enabled: true }));
		mgr.addRule(conditionRule("rule-b"));
		expect(mgr.hasRule("rule-b")).toBe(true);

		mgr.reconfigure({ enabled: false });
		// Disabled gates hasRule to false, but the rule is still held (re-enabling
		// restores it) — reconfigure never tore the manager down.
		expect(mgr.getSettings().enabled).toBe(false);
		mgr.reconfigure({ enabled: true });
		expect(mgr.hasRule("rule-b")).toBe(true);
	});
});

describe("TtsrManager.addOrUpdateRule", () => {
	it("refreshes the stored rule when only body/description changed (recompilation fields equal)", () => {
		const mgr = new TtsrManager(fullSettings());
		const original = conditionRule("rule-a");
		mgr.addRule(original);
		mgr.markInjectedByNames(["rule-a"]);
		expect(mgr.getRules().find(r => r.name === "rule-a")?.content).toBe("body");

		// Same name and identical recompilation-affecting fields (condition,
		// astCondition, scope, globs, interruptMode) — only the prose body and
		// description changed, which ttsrRuleContentEqual deliberately omits.
		const edited: Rule = { ...original, content: "edited body", description: "edited description" };
		const stillRegistered = mgr.addOrUpdateRule(edited);

		expect(stillRegistered).toBe(true);
		// Pre-fix, the equal-branch early-returned and kept the STALE object, so
		// getRules()/rule:// and injected content served the old "body".
		const stored = mgr.getRules().find(r => r.name === "rule-a");
		expect(stored?.content).toBe("edited body");
		expect(stored?.description).toBe("edited description");
		// The injection record survives the in-place swap (no recompile, no re-arm).
		expect(mgr.getInjectedRuleNames()).toContain("rule-a");
	});
});
