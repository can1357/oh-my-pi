/**
 * Builtin Defaults Provider
 *
 * Ships a curated set of default rules (mostly TTSR conventions) embedded into
 * the binary. Registered at the lowest priority so any user/project/tool rule
 * with the same `name` overrides the bundled copy (first-wins dedup by name).
 *
 * Users disable bundled rules three ways:
 *   - flip `ttsr.builtinRules` off (drops the whole set),
 *   - list a name in `ttsr.disabledRules` (drops one rule),
 *   - define a same-named rule in any higher-priority source (overrides it).
 * The first two are enforced in `bucketRules` (see capability/rule-buckets.ts).
 */

import { parseFrontmatter } from "@pk-nerdsaver-ai/pi-utils";
import { registerProvider } from "../capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "../capability/rule";
import { BUILTIN_SKILLS_PROVIDER_ID, type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { BUILTIN_RULE_SOURCES } from "./builtin-rules";
import { BUILTIN_SKILL_SOURCES } from "./builtin-skills";
import { buildRuleFromMarkdown, createSourceMeta } from "./helpers";

// ── Builtin Rules ───────────────────────────────────────────────────────────────

const RULES_DISPLAY_NAME = "Builtin Defaults";
// Lowest priority: every other rule provider wins a name conflict.
const RULES_PRIORITY = 1;

async function loadRules(_ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items = BUILTIN_RULE_SOURCES.map(({ name, content }) => {
		const virtualPath = `${BUILTIN_DEFAULTS_PROVIDER_ID}:${name}.md`;
		const source = createSourceMeta(BUILTIN_DEFAULTS_PROVIDER_ID, virtualPath, "user");
		return buildRuleFromMarkdown(name, content, virtualPath, source, { ruleName: name });
	});
	return { items };
}

registerProvider<Rule>(ruleCapability.id, {
	id: BUILTIN_DEFAULTS_PROVIDER_ID,
	displayName: RULES_DISPLAY_NAME,
	description: "Default rules shipped with the agent (disable via ttsr.builtinRules / ttsr.disabledRules)",
	priority: RULES_PRIORITY,
	load: loadRules,
});

// ── Builtin Skills ─────────────────────────────────────────────────────────────

const SKILLS_DISPLAY_NAME = "Builtin Skills";
// Lowest priority: every other skill provider wins a name conflict.
const SKILLS_PRIORITY = 1;

async function loadBuiltinSkills(_ctx: LoadContext): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	for (const { name, content } of BUILTIN_SKILL_SOURCES) {
		const virtualPath = `${BUILTIN_SKILLS_PROVIDER_ID}:${name}/SKILL.md`;
		const source = createSourceMeta(BUILTIN_SKILLS_PROVIDER_ID, virtualPath, "user");
		const { frontmatter, body } = parseFrontmatter(content, { source: virtualPath });
		items.push({
			name,
			path: virtualPath,
			content: body,
			frontmatter: frontmatter as Skill["frontmatter"],
			level: "user",
			_source: source,
		});
	}
	return { items };
}

registerProvider<Skill>(skillCapability.id, {
	id: BUILTIN_SKILLS_PROVIDER_ID,
	displayName: SKILLS_DISPLAY_NAME,
	description: 'Default skills shipped with the agent (disable via disabledExtensions: ["skill:<name>"])',
	priority: SKILLS_PRIORITY,
	load: loadBuiltinSkills,
});
