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
