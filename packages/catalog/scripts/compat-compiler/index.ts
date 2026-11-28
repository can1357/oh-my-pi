/**
 * Compat-rule compiler entry: reads a `rules/` tree (taxonomy, classes,
 * providers, runtime, auth) and compiles it into one {@link CompiledCompatRules}
 * value. Pure — importable from tests; the `gen:compat` CLI
 * (`scripts/compile-compat.ts`) persists the result as `rules.json`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CompiledCompatRules } from "../../src/compat/types";
import { compileAuth } from "./compile-auth";
import { compileBehavior } from "./compile-behavior";
import { compileCascade } from "./compile-cascade";
import { compileProviders } from "./compile-providers";
import { compileTaxonomy } from "./compile-taxonomy";
import { CompatCompileError } from "./kdl-reader";

export { CompatCompileError } from "./kdl-reader";

interface RuleSource {
	/** `rules/`-relative path, forward slashes. */
	file: string;
	text: string;
}

async function readGroup(rulesDir: string, group: string): Promise<RuleSource[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(path.join(rulesDir, group));
	} catch {
		return [];
	}
	const sources: RuleSource[] = [];
	for (const name of entries.sort()) {
		if (!name.endsWith(".kdl")) continue;
		const file = `${group}/${name}`;
		sources.push({ file, text: await Bun.file(path.join(rulesDir, file)).text() });
	}
	return sources;
}

/** Compiles the KDL rule tree rooted at `rulesDir` (deterministic output). */
export async function compileCompatRules(rulesDir: string): Promise<CompiledCompatRules> {
	const [taxonomy, classes, providers, runtime, auth] = await Promise.all([
		readGroup(rulesDir, "taxonomy"),
		readGroup(rulesDir, "classes"),
		readGroup(rulesDir, "providers"),
		readGroup(rulesDir, "runtime"),
		readGroup(rulesDir, "auth"),
	]);
	const behaviorSource = runtime.find(source => source.file === "runtime/behavior.kdl");
	const files = [...taxonomy, ...classes, ...providers, ...runtime, ...auth].map(source => source.file).sort();
	const policy = {
		version: 1,
		files,
		taxonomy: compileTaxonomy(taxonomy),
		cascade: compileCascade([...classes, ...providers]),
		behavior: compileBehavior(behaviorSource),
		auth: compileAuth(auth),
		providers: compileProviders(providers),
	} satisfies Omit<CompiledCompatRules, "hash" | "priceChanges">;

	// Catalog providers resolve credentials, env keys, and login through their auth policy.
	const authIds = new Set(policy.auth.providers.map(provider => provider.id));
	for (const id in policy.providers) {
		if (!authIds.has(id)) {
			throw new CompatCompileError(`auth/${id}.kdl`, undefined, `catalog provider \`${id}\` has no auth policy`);
		}
	}

	const dates = new Set<number>();
	const json = JSON.stringify(policy, (key, value: unknown) => {
		if (key === "effectiveFrom" && typeof value === "string") {
			const instant = Date.parse(value);
			if (Number.isFinite(instant)) dates.add(instant);
		}
		return value;
	});
	return { ...policy, hash: Bun.hash(json).toString(36), priceChanges: [...dates].sort((a, b) => a - b) };
}
