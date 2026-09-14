import { describe, expect, it } from "bun:test";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { bucketRules } from "@oh-my-pi/pi-coding-agent/capability/rule-buckets";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

function source(provider: string): Rule["_source"] {
	return { provider, providerName: provider, path: "/tmp/rule.md", level: "user" };
}

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "rule",
		path: partial.path ?? "/tmp/rule.md",
		content: partial.content ?? "body",
		globs: partial.globs,
		alwaysApply: partial.alwaysApply,
		description: partial.description,
		condition: partial.condition,
		astCondition: partial.astCondition,
		scope: partial.scope,
		agents: partial.agents,
		interruptMode: partial.interruptMode,
		_source: partial._source ?? source("native"),
	};
}

// A TtsrManager with TTSR disabled — every addRule is rejected. Full TtsrSettings
// so it type-checks; mirrors the inline object the disabled-manager test uses.
function disabledManager(): TtsrManager {
	return new TtsrManager({
		enabled: false,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
	});
}

describe("bucketRules", () => {
	it("registers a condition rule as TTSR and excludes it from rulebook/always buckets", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([ttsr], mgr);

		expect(rulebookRules).toHaveLength(0);
		expect(alwaysApplyRules).toHaveLength(0);
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["no-foo"]);
	});

	it("registers an ast-only rule as TTSR and excludes it from rulebook/always buckets", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-console", astCondition: ["console.log($A)"], description: "blocks console" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([ttsr], mgr);

		expect(rulebookRules).toHaveLength(0);
		expect(alwaysApplyRules).toHaveLength(0);
		expect(mgr.hasRules()).toBe(true);
		expect(mgr.hasAstRules()).toBe(true);
	});

	it("splits non-TTSR rules into always-apply and rulebook by metadata", () => {
		const mgr = new TtsrManager();
		const sticky = makeRule({ name: "sticky", alwaysApply: true, description: "sticky desc" });
		const book = makeRule({ name: "book", description: "rulebook desc" });
		const orphan = makeRule({ name: "orphan" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([sticky, book, orphan], mgr);

		expect(alwaysApplyRules.map(r => r.name)).toEqual(["sticky"]);
		expect(rulebookRules.map(r => r.name)).toEqual(["book"]);
		expect(mgr.hasRules()).toBe(false);
	});

	it("disabledRules drops a rule from every bucket and from TTSR registration", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });
		const book = makeRule({ name: "book", description: "rulebook desc" });

		const { rulebookRules } = bucketRules([ttsr, book], mgr, { disabledRules: ["no-foo", "book"] });

		expect(rulebookRules).toHaveLength(0);
		expect(mgr.hasRules()).toBe(false);
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" })).toHaveLength(0);
	});

	it("disabledRules trims entries and ignores blanks", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"] });

		bucketRules([ttsr], mgr, { disabledRules: ["  no-foo  ", "", "   "] });

		expect(mgr.hasRules()).toBe(false);
	});

	it("builtinRules:false drops builtin-defaults rules but keeps the rest", () => {
		const mgr = new TtsrManager();
		const builtin = makeRule({
			name: "builtin-foo",
			condition: ["FORBIDDEN"],
			_source: source(BUILTIN_DEFAULTS_PROVIDER_ID),
		});
		const userRule = makeRule({ name: "user-foo", condition: ["BANNED"], _source: source("native") });

		bucketRules([builtin, userRule], mgr, { builtinRules: false });

		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" })).toHaveLength(0);
		mgr.resetBuffer();
		expect(mgr.checkDelta("contains BANNED token", { source: "text" }).map(r => r.name)).toEqual(["user-foo"]);
	});

	it("includes builtin-defaults rules when builtinRules is unset (default on)", () => {
		const mgr = new TtsrManager();
		const builtin = makeRule({
			name: "builtin-foo",
			condition: ["FORBIDDEN"],
			_source: source(BUILTIN_DEFAULTS_PROVIDER_ID),
		});

		bucketRules([builtin], mgr);

		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["builtin-foo"]);
	});

	it("falls condition rules through to the rulebook when ttsr is disabled on the manager", () => {
		const mgr = new TtsrManager({
			enabled: false,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([ttsr], mgr);

		// Manager refused to register; condition rule degrades to its rulebook shape.
		expect(mgr.hasRules()).toBe(false);
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" })).toEqual([]);
		expect(alwaysApplyRules.map(r => r.name)).toEqual([]);
		expect(rulebookRules.map(r => r.name)).toEqual(["no-foo"]);
	});

	// In-session refresh re-runs bucketRules against the SAME live manager. A
	// TTSR-conditioned rule the manager already holds must stay consumed on the
	// re-bucket — pre-fix it gated on addRule()'s name-idempotent return (false
	// the second time), so the already-registered rule fell through into the
	// rulebook and the advertised roster grew on every refresh.
	it("keeps a TTSR-conditioned rule consumed across a re-bucket with the same live manager", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });

		const first = bucketRules([ttsr], mgr);
		expect(first.rulebookRules).toHaveLength(0);
		expect(first.alwaysApplyRules).toHaveLength(0);

		// Same manager, second pass — the rule is already registered, so addRule
		// returns false; membership (hasRule) is what must keep it consumed.
		const second = bucketRules([ttsr], mgr);
		expect(second.rulebookRules).toHaveLength(0);
		expect(second.alwaysApplyRules).toHaveLength(0);
		expect(mgr.getRules().map(r => r.name)).toEqual(["no-foo"]);
	});

	// The fix must not OVER-consume: a rule with a TTSR condition the manager
	// REJECTS (here TTSR disabled) is not held, so it must still fall through to
	// the rulebook on both a first and a repeat bucketing — matching init.
	it("falls a manager-rejected TTSR rule through to the rulebook on every bucketing", () => {
		const mgr = disabledManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });

		const first = bucketRules([ttsr], mgr);
		expect(mgr.hasRule("no-foo")).toBe(false);
		expect(first.rulebookRules.map(r => r.name)).toEqual(["no-foo"]);

		const second = bucketRules([ttsr], mgr);
		expect(mgr.hasRule("no-foo")).toBe(false);
		expect(second.rulebookRules.map(r => r.name)).toEqual(["no-foo"]);
	});

	// Observable roster stability: the rendered bucket count (rulebook + always)
	// must be identical across two identical re-buckets. Pre-fix it grew as
	// already-registered TTSR rules leaked into the rulebook.
	it("keeps the rendered bucket count stable across two identical re-buckets", () => {
		const mgr = new TtsrManager();
		const rules = [
			makeRule({ name: "ttsr-a", condition: ["ALPHA"], description: "a" }),
			makeRule({ name: "ttsr-b", astCondition: ["console.log($A)"], description: "b" }),
			makeRule({ name: "book-a", description: "rulebook a" }),
			makeRule({ name: "sticky-a", alwaysApply: true, description: "always a" }),
		];

		const first = bucketRules(rules, mgr);
		const second = bucketRules(rules, mgr);

		const count = (b: { rulebookRules: unknown[]; alwaysApplyRules: unknown[] }) =>
			b.rulebookRules.length + b.alwaysApplyRules.length;
		expect(count(first)).toBe(2);
		expect(count(second)).toBe(count(first));
	});

	// Precedence: a rule that is BOTH TTSR-conditioned AND alwaysApply must be
	// consumed by the manager, never pushed into the always-apply bucket. The
	// TTSR block runs (and `continue`s) before the alwaysApply branch; a reorder
	// that checked alwaysApply first would double-count the rule (registered for
	// monitoring AND advertised as always-on).
	it("consumes a TTSR-conditioned alwaysApply rule via TTSR, not the always bucket", () => {
		const mgr = new TtsrManager();
		const rule = makeRule({ name: "sticky-ttsr", condition: ["FORBIDDEN"], alwaysApply: true, description: "d" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([rule], mgr);

		expect(mgr.hasRule("sticky-ttsr")).toBe(true);
		expect(rulebookRules).toHaveLength(0);
		expect(alwaysApplyRules).toHaveLength(0);
	});

	// TtsrManager.hasRule is the membership predicate bucketRules now gates on.
	// It must be true for a registered rule (whether or not this call registered
	// it), false for an unknown name, and false after a rejected addRule.
	it("TtsrManager.hasRule reports membership independent of addRule's return", () => {
		const mgr = new TtsrManager();
		const rule = makeRule({ name: "no-foo", condition: ["FORBIDDEN"] });

		expect(mgr.hasRule("no-foo")).toBe(false);
		expect(mgr.addRule(rule)).toBe(true);
		expect(mgr.hasRule("no-foo")).toBe(true);
		// Idempotent: second add returns false, but membership persists.
		expect(mgr.addRule(rule)).toBe(false);
		expect(mgr.hasRule("no-foo")).toBe(true);
		expect(mgr.hasRule("never-added")).toBe(false);
	});

	it("TtsrManager.hasRule stays false after a rejected addRule", () => {
		const disabled = disabledManager();
		expect(disabled.addRule(makeRule({ name: "no-foo", condition: ["FORBIDDEN"] }))).toBe(false);
		expect(disabled.hasRule("no-foo")).toBe(false);

		// Empty condition set is also rejected even when TTSR is enabled.
		const enabled = new TtsrManager();
		expect(enabled.addRule(makeRule({ name: "empty", description: "no conditions" }))).toBe(false);
		expect(enabled.hasRule("empty")).toBe(false);
	});

	// bucketRules reports the condition-bearing rules the manager consumed, so an
	// in-session refresh can reconcile the reused manager.
	it("reports the consumed TTSR rule names via ttsrRuleNames", () => {
		const mgr = new TtsrManager();
		const rules = [
			makeRule({ name: "ttsr-a", condition: ["ALPHA"], description: "a" }),
			makeRule({ name: "ttsr-b", astCondition: ["console.log($A)"], description: "b" }),
			makeRule({ name: "book", description: "rulebook" }),
		];

		const { ttsrRuleNames } = bucketRules(rules, mgr);

		expect([...ttsrRuleNames].sort()).toEqual(["ttsr-a", "ttsr-b"]);
	});

	// A condition rule deleted from disk (or newly disabled) is no longer in the
	// discovered/enabled set, so retainRules drops its stale registration —
	// otherwise getRules() would republish it into activeRules, still reachable
	// via rule:// and still triggering.
	it("retainRules drops a rule absent from the enabled set and stops it triggering", () => {
		const mgr = new TtsrManager();
		const gone = makeRule({ name: "gone", condition: ["FORBIDDEN"], description: "d" });
		const kept = makeRule({ name: "kept", condition: ["BANNED"], description: "d" });

		const first = bucketRules([gone, kept], mgr);
		expect(
			mgr
				.getRules()
				.map(r => r.name)
				.sort(),
		).toEqual(["gone", "kept"]);
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["gone"]);

		// Simulate a refresh where "gone" was deleted from disk: only "kept" is
		// rediscovered, so bucketRules consumes only it. Pre-fix, the reused
		// manager still held "gone".
		const second = bucketRules([kept], mgr);
		mgr.retainRules(second.ttsrRuleNames);
		void first;

		expect(mgr.getRules().map(r => r.name)).toEqual(["kept"]);
		// The dropped rule no longer triggers; the survivor still does.
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" })).toEqual([]);
		expect(mgr.checkDelta("contains BANNED token", { source: "text" }).map(r => r.name)).toEqual(["kept"]);
	});

	// retainRules must recompute the text/thinking arming flags from survivors,
	// so removing the only text rule stops the text buffer from arming.
	it("retainRules recomputes canMatch flags after dropping the last text rule", () => {
		const mgr = new TtsrManager();
		const textRule = makeRule({ name: "text-rule", condition: ["FORBIDDEN"], description: "d" });

		bucketRules([textRule], mgr);
		expect(mgr.checkDelta("FORBIDDEN", { source: "text" }).map(r => r.name)).toEqual(["text-rule"]);

		mgr.retainRules(new Set());
		expect(mgr.getRules()).toEqual([]);
		expect(mgr.checkDelta("FORBIDDEN", { source: "text" })).toEqual([]);
	});

	// An in-place edit to a condition rule (same name) must recompile its TTSR
	// entry on refresh: pre-fix, bucketRules called addRule, which no-ops on an
	// existing name, so the manager kept matching the OLD condition and rule://
	// republished the stale rule. addOrUpdateRule recompiles the surviving entry.
	it("re-triggers an in-place-edited condition rule on the NEW condition after re-bucket", () => {
		const mgr = new TtsrManager();
		const original = makeRule({ name: "no-foo", condition: ["OLDWORD"], description: "d" });

		bucketRules([original], mgr);
		expect(mgr.checkDelta("contains OLDWORD token", { source: "text" }).map(r => r.name)).toEqual(["no-foo"]);

		// Same name, edited condition — the refresh re-buckets against the reused
		// manager. The OLD condition must stop matching and the NEW one must fire.
		const edited = makeRule({ name: "no-foo", condition: ["NEWWORD"], description: "d" });
		const second = bucketRules([edited], mgr);

		expect(second.rulebookRules).toHaveLength(0);
		expect(second.ttsrRuleNames.has("no-foo")).toBe(true);
		expect(mgr.checkDelta("contains OLDWORD token", { source: "text" })).toEqual([]);
		expect(mgr.checkDelta("contains NEWWORD token", { source: "text" }).map(r => r.name)).toEqual(["no-foo"]);
		// rule:// republishes the fresh object, not the stale one.
		expect(mgr.getRules().map(r => r.condition?.[0])).toEqual(["NEWWORD"]);
	});

	// A same-name edit that only changes non-TTSR content (the rulebook body)
	// must NOT recompile — the entry (and its injection state) is preserved.
	it("preserves the injection state of a condition rule when only its body changes", () => {
		const mgr = new TtsrManager();
		const original = makeRule({ name: "no-foo", condition: ["WORD"], content: "old body", description: "d" });

		bucketRules([original], mgr);
		mgr.markInjectedByNames(["no-foo"]);
		expect(mgr.getInjectedRuleNames()).toContain("no-foo");

		const edited = makeRule({ name: "no-foo", condition: ["WORD"], content: "new body", description: "d" });
		bucketRules([edited], mgr);

		// Same condition → entry kept → injection record survives (an already-
		// injected rule stays injected; a recompile would have reset that).
		expect(mgr.getInjectedRuleNames()).toContain("no-foo");
		expect(mgr.hasRule("no-foo")).toBe(true);
	});

	// An edit that removes the usable condition drops the rule from TTSR: it must
	// fall through to the rulebook and stop triggering.
	it("drops a condition rule from TTSR when the edit removes its condition", () => {
		const mgr = new TtsrManager();
		const original = makeRule({ name: "no-foo", condition: ["WORD"], description: "blocks" });

		bucketRules([original], mgr);
		expect(mgr.hasRule("no-foo")).toBe(true);

		// Condition removed, still a described rule → now a plain rulebook entry.
		const edited = makeRule({ name: "no-foo", condition: [], description: "blocks" });
		const second = bucketRules([edited], mgr);
		mgr.retainRules(second.ttsrRuleNames);

		expect(mgr.hasRule("no-foo")).toBe(false);
		expect(second.rulebookRules.map(r => r.name)).toEqual(["no-foo"]);
		expect(mgr.checkDelta("contains WORD token", { source: "text" })).toEqual([]);
	});
});

describe("bucketRules agent scoping", () => {
	it("scopes a scout-only TTSR rule to scout and leaves it inert for main", () => {
		const rule = makeRule({
			name: "scout-only",
			condition: ["FORBIDDEN"],
			description: "blocks foo",
			agents: ["scout"],
		});

		const scoutMgr = new TtsrManager();
		const { rulebookRules: scoutRulebook, alwaysApplyRules: scoutAlways } = bucketRules([rule], scoutMgr, {
			agentName: "scout",
		});
		expect(scoutMgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual([
			"scout-only",
		]);
		expect(scoutRulebook).toHaveLength(0);
		expect(scoutAlways).toHaveLength(0);

		const mainMgr = new TtsrManager();
		const { rulebookRules: mainRulebook, alwaysApplyRules: mainAlways } = bucketRules([rule], mainMgr, {
			agentName: "main",
		});
		expect(mainMgr.hasRules()).toBe(false);
		expect(mainRulebook).toHaveLength(0);
		expect(mainAlways).toHaveLength(0);
	});

	it("`main` in the agents list includes the top-level session", () => {
		const rule = makeRule({ name: "main-only", condition: ["FORBIDDEN"], agents: ["main"] });
		const mgr = new TtsrManager();
		bucketRules([rule], mgr, { agentName: "main" });
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["main-only"]);
	});

	it("matches a glob pattern against the agent name", () => {
		const rule = makeRule({ name: "foreman-only", condition: ["FORBIDDEN"], agents: ["foreman-*"] });

		const alphaMgr = new TtsrManager();
		bucketRules([rule], alphaMgr, { agentName: "foreman-alpha" });
		expect(alphaMgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual([
			"foreman-only",
		]);

		const foremanMgr = new TtsrManager();
		bucketRules([rule], foremanMgr, { agentName: "foreman" });
		expect(foremanMgr.hasRules()).toBe(false);
	});

	it("a rule with no `agents` field applies to every agent", () => {
		const rule = makeRule({ name: "everyone", condition: ["FORBIDDEN"] });

		const mainMgr = new TtsrManager();
		bucketRules([rule], mainMgr, { agentName: "main" });
		expect(mainMgr.hasRules()).toBe(true);

		const scoutMgr = new TtsrManager();
		bucketRules([rule], scoutMgr, { agentName: "scout" });
		expect(scoutMgr.hasRules()).toBe(true);
	});

	it("gates the always-apply bucket too", () => {
		const rule = makeRule({ name: "scout-always", alwaysApply: true, agents: ["scout"] });

		const scoutMgr = new TtsrManager();
		const { alwaysApplyRules: scoutAlways } = bucketRules([rule], scoutMgr, { agentName: "scout" });
		expect(scoutAlways.map(r => r.name)).toEqual(["scout-always"]);

		const mainMgr = new TtsrManager();
		const { alwaysApplyRules: mainAlways } = bucketRules([rule], mainMgr, { agentName: "main" });
		expect(mainAlways).toHaveLength(0);
	});

	it("bucketRules with no agentName keeps a scoped rule (list/scan contract)", () => {
		const rule = makeRule({ name: "scout-only", condition: ["FORBIDDEN"], agents: ["scout"] });
		const mgr = new TtsrManager();
		const { rulebookRules, alwaysApplyRules } = bucketRules([rule], mgr);
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["scout-only"]);
		expect(rulebookRules).toHaveLength(0);
		expect(alwaysApplyRules).toHaveLength(0);
	});

	it("trims and lowercases agentName before matching a glob pattern", () => {
		const rule = makeRule({ name: "scout-only", condition: ["FORBIDDEN"], agents: ["scout"] });
		const mgr = new TtsrManager();
		bucketRules([rule], mgr, { agentName: " Scout " });
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["scout-only"]);
	});
});
