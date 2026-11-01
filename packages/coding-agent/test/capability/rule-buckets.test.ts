import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	BUILTIN_DEFAULTS_PROVIDER_ID,
	type Rule,
	type RuleScopeModel,
} from "@oh-my-pi/pi-coding-agent/capability/rule";
import { bucketRules } from "@oh-my-pi/pi-coding-agent/capability/rule-buckets";
import { ruleRecordKey, TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { logger, parseTtsrRecordKey } from "@oh-my-pi/pi-utils";

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
		question: partial.question,
		scope: partial.scope,
		agents: partial.agents,
		models: partial.models,
		providers: partial.providers,
		class: partial.class,
		family: partial.family,
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

	it("replaces an edited TTSR rule while preserving its injection state", () => {
		const mgr = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 0,
		});
		const original = makeRule({ name: "guard", condition: ["OLD"], content: "old content" });
		bucketRules([original], mgr);
		mgr.markInjected([original]);

		const updated = makeRule({ name: "guard", condition: ["NEW"], content: "new content" });
		bucketRules([updated], mgr, { replaceTtsrRules: true });

		expect(mgr.getInjectedRuleNames()).toEqual(["guard"]);
		expect(mgr.getRules()).toEqual([updated]);
		expect(mgr.checkDelta("OLD", { source: "text" })).toEqual([]);
		mgr.resetBuffer();
		expect(mgr.checkDelta("NEW", { source: "text" })).toEqual([updated]);
	});

	it("removes stale TTSR registrations and injection state after rename or deletion", () => {
		const mgr = new TtsrManager();
		const original = makeRule({ name: "old-guard", condition: ["OLD"] });
		bucketRules([original], mgr);
		mgr.markInjected([original]);

		const renamed = makeRule({ name: "new-guard", condition: ["NEW"] });
		bucketRules([renamed], mgr, { replaceTtsrRules: true });

		expect(mgr.getRules()).toEqual([renamed]);
		expect(mgr.getInjectedRuleNames()).toEqual([]);
		expect(mgr.checkDelta("OLD", { source: "text" })).toEqual([]);
		mgr.resetBuffer();
		expect(mgr.checkDelta("NEW", { source: "text" })).toEqual([renamed]);

		mgr.markInjected([renamed]);
		bucketRules([], mgr, { replaceTtsrRules: true });

		expect(mgr.hasRules()).toBe(false);
		expect(mgr.getInjectedRuleNames()).toEqual([]);
		expect(mgr.checkDelta("NEW", { source: "text" })).toEqual([]);
	});

	it("keeps the registered rules and injection state when compiling a replacement throws", () => {
		const mgr = new TtsrManager();
		const original = makeRule({ name: "guard", condition: ["OLD"] });
		bucketRules([original], mgr);
		mgr.markInjected([original]);

		const glob = vi.spyOn(Bun, "Glob").mockImplementation((() => {
			throw new Error("glob compile failed");
		}) as never);
		const replacement = makeRule({ name: "other", condition: ["NEW"], globs: ["src/**"] });
		try {
			expect(() => bucketRules([replacement], mgr, { replaceTtsrRules: true })).toThrow("glob compile failed");
		} finally {
			glob.mockRestore();
		}

		expect(mgr.getRules()).toEqual([original]);
		expect(mgr.getInjectedRuleNames()).toEqual(["guard"]);
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

	it("registers a question-only rule as judged TTSR that never matches the stream", () => {
		const mgr = new TtsrManager();
		const judged = makeRule({
			name: "honest-tests",
			question: "Does the reply claim tests pass?",
			condition: ["tests pass"],
			description: "no unverified claims",
		});

		const { rulebookRules, alwaysApplyRules } = bucketRules([judged], mgr);

		expect(rulebookRules).toHaveLength(0);
		expect(alwaysApplyRules).toHaveLength(0);
		expect(mgr.hasJudgedRules()).toBe(true);
		// Its condition only gates the question; streamed text never interrupts.
		expect(mgr.checkDelta("all tests pass", { source: "text" })).toEqual([]);
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

describe("bucketRules model scoping", () => {
	const opus: RuleScopeModel = {
		provider: "anthropic",
		id: "claude-opus-5",
		identity: { class: "anthropic", family: "opus" },
	};
	const routedSonnet: RuleScopeModel = {
		provider: "openrouter",
		id: "anthropic/claude-sonnet-5",
		identity: { class: "anthropic", family: "sonnet" },
	};
	const unclassified: RuleScopeModel = { provider: "local", id: "my-model", identity: { class: "unknown" } };

	function bucketNames(rules: Rule[], model: RuleScopeModel | undefined) {
		const mgr = new TtsrManager();
		const { rulebookRules, alwaysApplyRules } = bucketRules(rules, mgr, { model });
		return {
			always: alwaysApplyRules.map(r => r.name),
			rulebook: rulebookRules.map(r => r.name),
			ttsr: mgr.getRules().map(r => r.name),
		};
	}

	it("drops a non-matching scoped rule from every bucket and keeps unscoped rules", () => {
		const rules = [
			makeRule({ name: "opus-always", alwaysApply: true, models: ["*/claude-opus-*"] }),
			makeRule({ name: "opus-book", description: "opus tips", family: ["opus"] }),
			makeRule({ name: "opus-ttsr", condition: ["FORBIDDEN"], providers: ["anthropic"], family: ["opus"] }),
			makeRule({ name: "plain-always", alwaysApply: true }),
			makeRule({ name: "plain-ttsr", condition: ["FORBIDDEN"] }),
		];

		expect(bucketNames(rules, opus)).toEqual({
			always: ["opus-always", "plain-always"],
			rulebook: ["opus-book"],
			ttsr: ["opus-ttsr", "plain-ttsr"],
		});
		expect(bucketNames(rules, routedSonnet)).toEqual({
			always: ["plain-always"],
			rulebook: [],
			ttsr: ["plain-ttsr"],
		});
		// No model: scoping disabled (CLI inventories).
		expect(bucketNames(rules, undefined)).toEqual(bucketNames(rules, opus));
	});

	it("ORs patterns within a field and ANDs across fields", () => {
		const rule = makeRule({
			name: "claude-direct",
			alwaysApply: true,
			class: ["anthropic", "openai"],
			providers: ["anthropic"],
		});
		expect(bucketNames([rule], opus).always).toEqual(["claude-direct"]);
		// Class matches, provider does not.
		expect(bucketNames([rule], routedSonnet).always).toEqual([]);
		// A family scope never matches a model without a family.
		expect(bucketNames([makeRule({ name: "f", alwaysApply: true, family: ["*"] })], unclassified).always).toEqual([]);
	});

	it("keeps the first matching same-named variant", () => {
		const opusVariant = makeRule({ name: "style", content: "opus", alwaysApply: true, family: ["opus"] });
		const anthropicVariant = makeRule({
			name: "style",
			content: "anthropic",
			alwaysApply: true,
			class: ["anthropic"],
		});
		const pick = (model: RuleScopeModel) =>
			bucketRules([opusVariant, anthropicVariant], new TtsrManager(), { model }).alwaysApplyRules.map(
				r => r.content,
			);

		expect(pick(opus)).toEqual(["opus"]);
		expect(pick(routedSonnet)).toEqual(["anthropic"]);
	});
});

describe("TTSR injection records across model scopes", () => {
	const opus: RuleScopeModel = {
		provider: "anthropic",
		id: "claude-opus-5",
		identity: { class: "anthropic", family: "opus" },
	};
	const sonnet: RuleScopeModel = {
		provider: "anthropic",
		id: "claude-sonnet-5",
		identity: { class: "anthropic", family: "sonnet" },
	};
	const gpt: RuleScopeModel = { provider: "openai", id: "gpt-5", identity: { class: "openai", family: "gpt" } };
	const opusGuard = makeRule({ name: "guard", condition: ["FORBIDDEN"], family: ["opus"] });
	const sonnetGuard = makeRule({ name: "guard", condition: ["FORBIDDEN"], family: ["sonnet"] });
	const variants = [opusGuard, sonnetGuard];

	function onceManager(): TtsrManager {
		return new TtsrManager({ enabled: true, contextMode: "discard", interruptMode: "always", repeatMode: "once" });
	}

	function scopeTo(
		mgr: TtsrManager,
		rules: Rule[],
		model: RuleScopeModel,
		options: { disabledRules?: string[] } = {},
	) {
		bucketRules(rules, mgr, { model, replaceTtsrRules: true, agentName: "main", ...options });
		mgr.resetBuffer();
	}

	function fires(mgr: TtsrManager): Rule[] {
		const matches = mgr.checkDelta("contains FORBIDDEN token", { source: "text" });
		mgr.resetBuffer();
		return matches;
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps a once-mode record across a round trip to a model outside the rule's scope", () => {
		const mgr = onceManager();
		scopeTo(mgr, [opusGuard], opus);
		mgr.markInjected(fires(mgr));
		scopeTo(mgr, [opusGuard], gpt);
		scopeTo(mgr, [opusGuard], opus);
		expect(fires(mgr)).toEqual([]);
	});

	it("fires each same-named variant once across switches", () => {
		const mgr = onceManager();
		scopeTo(mgr, variants, opus);
		const opusHit = fires(mgr);
		expect(opusHit).toEqual([opusGuard]);
		mgr.markInjected(opusHit);

		scopeTo(mgr, variants, sonnet);
		const sonnetHit = fires(mgr);
		expect(sonnetHit).toEqual([sonnetGuard]);
		mgr.markInjected(sonnetHit);

		scopeTo(mgr, variants, opus);
		expect(fires(mgr)).toEqual([]);
		scopeTo(mgr, variants, sonnet);
		expect(fires(mgr)).toEqual([]);
	});

	it("prunes every variant's record when the name is deleted, disabled, or agent-excluded", () => {
		const injectedOnBoth = (): TtsrManager => {
			const mgr = onceManager();
			scopeTo(mgr, variants, opus);
			mgr.markInjected(fires(mgr));
			scopeTo(mgr, variants, sonnet);
			mgr.markInjected(fires(mgr));
			expect(mgr.getInjectedRuleNames()).toHaveLength(2);
			return mgr;
		};

		const deleted = injectedOnBoth();
		scopeTo(deleted, [], opus);
		expect(deleted.getInjectedRuleNames()).toEqual([]);

		const disabled = injectedOnBoth();
		scopeTo(disabled, variants, opus, { disabledRules: ["guard"] });
		expect(disabled.getInjectedRuleNames()).toEqual([]);

		const excluded = injectedOnBoth();
		scopeTo(
			excluded,
			variants.map(rule => ({ ...rule, agents: ["scout"] })),
			opus,
		);
		expect(excluded.getInjectedRuleNames()).toEqual([]);
	});

	it("restores a persisted variant key without suppressing the other variant", () => {
		const before = onceManager();
		scopeTo(before, variants, opus);
		const persisted = before.recordKeysFor(["guard"]);
		expect(persisted).toEqual([ruleRecordKey(opusGuard)]);

		const resumed = onceManager();
		resumed.restoreInjected(persisted);
		scopeTo(resumed, variants, opus);
		expect(fires(resumed)).toEqual([]);
		scopeTo(resumed, variants, sonnet);
		expect(fires(resumed)).toEqual([sonnetGuard]);
	});

	it("treats a legacy bare-name record as covering every variant", () => {
		const mgr = onceManager();
		mgr.restoreInjected(["guard"]);
		scopeTo(mgr, variants, opus);
		expect(fires(mgr)).toEqual([]);
		scopeTo(mgr, variants, sonnet);
		expect(fires(mgr)).toEqual([]);
	});

	it("warns about an invalid regex once per discovered rule object", () => {
		const warn = vi.spyOn(logger, "warn");
		const invalidWarnings = () =>
			warn.mock.calls.filter(([message]) => String(message).includes("invalid regex")).length;
		const broken = makeRule({ name: "broken", condition: ["(", "FORBIDDEN"] });
		const mgr = onceManager();
		for (const model of [opus, sonnet, gpt, opus]) scopeTo(mgr, [broken], model);
		expect(invalidWarnings()).toBe(1);

		// Rediscovery yields a new rule object, which is compiled (and warned about) again.
		scopeTo(mgr, [{ ...broken }], opus);
		expect(invalidWarnings()).toBe(2);
	});

	it("keys an unscoped rule by its name and a scoped variant by a 16-hex-digit scope hash", () => {
		const scoped = makeRule({ name: "a::b", condition: ["X"], family: ["opus"] });
		expect(parseTtsrRecordKey(ruleRecordKey(scoped))).toEqual({
			name: "a::b",
			scopeHash: expect.stringMatching(/^[0-9a-f]{16}$/),
		});
		expect(ruleRecordKey(makeRule({ name: "a::b" }))).toBe("a::b");
	});
});
