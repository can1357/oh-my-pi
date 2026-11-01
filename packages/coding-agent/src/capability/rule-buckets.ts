/**
 * Rule bucketing
 *
 * Single funnel that every discovered rule passes through on its way into a
 * session. It applies the user's disable levers, registers TTSR rules with the
 * manager, and splits the rest into the always-apply and rulebook buckets.
 *
 * Precedence (matches docs/rulebook-matching-pipeline.md §5):
 *   1. disabledRules  — dropped before any bucket assignment
 *   2. builtin drop   — `builtinRules === false` drops `builtin-defaults` rules
 *   3. agents scope   — rules whose `agents` globs do not match `options.agentName` are dropped
 *   4. model scope    — rules whose `models`/`providers`/`class`/`family` do not admit `options.model` are dropped;
 *                       of the same-named rules left, the first (highest-precedence) one wins
 *   5. TTSR           — non-empty `condition`/`astCondition`/`question` the manager already tracks or newly accepts
 *   6. always         — `alwaysApply === true`
 *   7. rulebook       — has a `description`
 */
import type { TtsrManager } from "../export/ttsr";
import {
	BUILTIN_DEFAULTS_PROVIDER_ID,
	type Rule,
	type RuleScopeModel,
	ruleAppliesToAgent,
	ruleAppliesToModel,
} from "./rule";

export interface RuleBuckets {
	rulebookRules: Rule[];
	alwaysApplyRules: Rule[];
}

export interface BucketRulesOptions {
	/** Rule names to drop entirely (bundled defaults and user rules alike). */
	disabledRules?: readonly string[];
	/** When false, drop every rule from the bundled `builtin-defaults` provider. */
	builtinRules?: boolean;
	/**
	 * Agent this session runs as: `"main"` for a top-level session, otherwise the
	 * agent definition name. Rules whose `agents` globs do not match are dropped
	 * from every bucket. Omit to disable agent scoping (CLI inventory listings).
	 */
	agentName?: string;
	/**
	 * Model that receives this session's prompt. Rules whose model scope does not
	 * admit it are dropped from every bucket. Omit to disable model scoping
	 * (CLI inventory listings).
	 */
	model?: RuleScopeModel;
	/** Replace existing TTSR registrations before bucketing this complete rule snapshot. */
	replaceTtsrRules?: boolean;
	/** With `replaceTtsrRules`, keep the in-flight TTSR stream buffers (see `TtsrManager.replaceRules`). */
	keepTtsrBuffers?: boolean;
}

/**
 * Filter and bucket rules, registering TTSR rules on `ttsrManager` as a side
 * effect. Disabled rules are dropped before any bucket assignment, so a
 * disabled rule is neither matched as TTSR nor surfaced via `rule://`.
 */
export function bucketRules(
	rules: readonly Rule[],
	ttsrManager: TtsrManager,
	options: BucketRulesOptions = {},
): RuleBuckets {
	const includeBuiltin = options.builtinRules !== false;
	const disabled = new Set<string>();
	for (const raw of options.disabledRules ?? []) {
		const name = raw.trim();
		if (name.length > 0) disabled.add(name);
	}

	const includedRules: Rule[] = [];
	const includedNames = new Set<string>();
	// Names this session could load on some model: TTSR injection records survive re-scoping for these.
	const snapshotNames = new Set<string>();
	for (const rule of rules) {
		if (disabled.has(rule.name)) continue;
		if (!includeBuiltin && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) continue;
		if (!ruleAppliesToAgent(rule, options.agentName)) continue;
		snapshotNames.add(rule.name);
		if (!ruleAppliesToModel(rule, options.model)) continue;
		// Discovery keeps same-named rules with different model scopes; downstream state is keyed by name.
		if (includedNames.has(rule.name)) continue;
		includedNames.add(rule.name);
		includedRules.push(rule);
	}

	const replacedTtsrNames = options.replaceTtsrRules
		? ttsrManager.replaceRules(includedRules, snapshotNames, { keepBuffers: options.keepTtsrBuffers })
		: undefined;
	const rulebookRules: Rule[] = [];
	const alwaysApplyRules: Rule[] = [];

	for (const rule of includedRules) {
		const hasTtsrCondition =
			(rule.condition && rule.condition.length > 0) ||
			(rule.astCondition && rule.astCondition.length > 0) ||
			rule.question !== undefined;
		const isTtsrRule = hasTtsrCondition ? (replacedTtsrNames?.has(rule.name) ?? ttsrManager.addRule(rule)) : false;
		if (isTtsrRule) continue;
		if (rule.alwaysApply === true) {
			alwaysApplyRules.push(rule);
			continue;
		}
		if (rule.description) {
			rulebookRules.push(rule);
		}
	}

	return { rulebookRules, alwaysApplyRules };
}
