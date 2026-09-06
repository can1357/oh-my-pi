/**
 * Compat-rule compiler entry: reads a `rules/` tree (taxonomy, classes,
 * providers, runtime) and compiles it into one {@link CompiledCompatRules}
 * value. Pure — importable from tests; the `gen:compat` CLI
 * (`scripts/compile-compat.ts`) persists the result as `rules.json`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CompiledCompatRules } from "../../src/compat/types";
import { compileBehavior } from "./compile-behavior";
import { compileCascade } from "./compile-cascade";
import { compileTaxonomy } from "./compile-taxonomy";

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
	const [taxonomy, classes, providers, runtime] = await Promise.all([
		readGroup(rulesDir, "taxonomy"),
		readGroup(rulesDir, "classes"),
		readGroup(rulesDir, "providers"),
		readGroup(rulesDir, "runtime"),
	]);
	const behaviorSource = runtime.find(source => source.file === "runtime/behavior.kdl");
	const files = [...taxonomy, ...classes, ...providers, ...runtime].map(source => source.file).sort();
	return {
		version: 1,
		files,
		taxonomy: compileTaxonomy(taxonomy),
		cascade: compileCascade([...classes, ...providers]),
		behavior: compileBehavior(behaviorSource),
	};
}
